import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import jwt from "jsonwebtoken";
import amqp from 'amqplib';
async function connectRabbitMQ() {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
        const channel = await connection.createChannel();

        const queues = ['fight.user.registered.queue', 'fight.guest.registered.queue'];

        for (const queue of queues) {
            // Aseguramos que la cola existe
            await channel.assertQueue(queue, { durable: true });

            console.log(`[*] Escuchando en: ${queue}`);

            channel.consume(queue, (msg) => {
                if (msg !== null) {
                    const content = JSON.parse(msg.content.toString());
                    console.log(`[EVENTO] Recibido de ${queue}:`, content);

                    // Aquí disparamos la lógica para activar el chat
                    // Asumimos que el mensaje trae un roomId o gameId
                    const roomId = content.gameId || content.roomId;

                    // Asegúrate de que esta parte se vea así en tu función:
                    if (roomId) {
                        console.log(`[RABBIT] Activando pelea: ${roomId}`);
                        partidaIniciada = true;
                        fightId = String(roomId); // Actualizamos el estado global

                        // Notificamos a todos en la sala principal
                        io.to(lobby).emit('estado_chat', { activo: true, fightId: roomId });

                        // Forzamos la actualización de la lista de voces
                        actualizarYEnviarLista();
                    }

                    channel.ack(msg); // Confirmamos la lectura para que salga de la cola
                }
            }, { noAck: false }); // Usamos confirmación manual para seguridad
        }
    } catch (error) {
        console.error("Error en RabbitMQ:", error);
    }
}


const app = express();
const server = createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });

const __dirname = dirname(fileURLToPath(import.meta.url));
const lobby = "sala-principal";

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// ─── ESTADO EN MEMORIA ────────────────────────────────────────────────────────
let partidaIniciada = false;
let fightId = null;

/**
 * players autorrizados: Map<userId, { username, playerType, socketId|null }>
 * Se llena cuando Fight-Service llama POST /api/iniciar-partida
 */
const authorizedPlayers = new Map();

/**
 * socketToUser: Map<socketId, { userId, username }>
 * Se llena cuando el cliente emite 'identificar'
 */
const socketToUser = new Map();


/** advertencias por userId */
const warningCount = new Map();
const MAX_WARNINGS = 3;

// ─── MONGODB ──────────────────────────────────────────────────────────────────
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) { console.error("❌ MONGO_URI no definida"); process.exit(1); }

const jwtSecret = process.env.JWT_SECRET;

mongoose.connect(mongoURI)
    .then(() => console.log("✅ Conectado a MongoDB Atlas: VOICE-CHAT"))
    .catch(err => console.error("❌ Error Mongo:", err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const Reporte = mongoose.model('Report', new mongoose.Schema({
    fightId: String,
    emisorId: String,
    targetId: String,
    motivo: String,
    fecha: { type: Date, default: Date.now }
}), 'REPORT');

const Mensaje = mongoose.model('Message', new mongoose.Schema({
    fightId: String,
    userId: String,
    username: String,
    texto: String,
    timestamp: { type: Date, default: Date.now }
}), 'MESSAGES');

const Advertencia = mongoose.model('Warning', new mongoose.Schema({
    fightId: String,
    userId: String,
    username: String,
    texto: String,
    count: Number,
    timestamp: { type: Date, default: Date.now }
}), 'WARNINGS');

// ─── FILTRO DE PALABRAS ───────────────────────────────────────────────────────
const PALABRAS_BANEADAS = [
    "tonto","feo","spam","maldito","idiota","estupido","imbecil","bobada",
    "mierda","puta","puto","cabron","hijueputa","hp","culero","pendejo",
    "maricon","hdp","gonorrea","malparido","mongolo","retrasado","inutil",
    "bastardo","desgraciado","subnormal","gilipollas","cagada","perra","zorra",
    "fuck","shit","bitch","asshole","crap","idiot","moron","loser","damn",
];

function procesarMensaje(texto) {
    if (!texto) return { textoFiltrado: "", huboInfraccion: false };
    let textoFiltrado = texto;
    let huboInfraccion = false;
    PALABRAS_BANEADAS.forEach(palabra => {
        const regex = new RegExp(`\\b${palabra}\\b`, 'gi');
        if (regex.test(texto)) huboInfraccion = true;
        textoFiltrado = textoFiltrado.replace(regex, "****");
    });
    return { textoFiltrado, huboInfraccion };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getUserFromSocket(socketId) {
    return socketToUser.get(socketId) || null;
}

function isAuthorizedUser(userId) {
    return Boolean(userId) && authorizedPlayers.has(userId);
}

function isAuthorizedSocket(socketId) {
    const user = getUserFromSocket(socketId);
    return isAuthorizedUser(user?.userId);
}

function getAuthorizedSocketByUserId(userId) {
    if (!isAuthorizedUser(userId)) return null;
    const entry = authorizedPlayers.get(userId);
    return entry?.socketId || null;
}

function emitToAuthorized(event, payload) {
    for (const [, entry] of authorizedPlayers.entries()) {
        if (entry.socketId) {
            io.to(entry.socketId).emit(event, payload);
        }
    }
}

// ─── ESTÁTICOS ───────────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(join(__dirname, 'index.html')));

// ─── REST: INICIAR PARTIDA (llamado por Fight-Service) ────────────────────────
app.post("/api/iniciar-partida", (req, res) => {
    const { fightId: fid, roomId, players } = req.body;

    if (!fid || !Array.isArray(players)) {
        return res.status(400).json({ status: "error", message: "fightId y players son requeridos" });
    }

    fightId = String(fid);
    partidaIniciada = true;
    authorizedPlayers.clear();
    warningCount.clear();

    players
        .filter(p => p?.playerType === "PLAYER")
        .forEach(p => {
            authorizedPlayers.set(p.userId, {
                username: p.username || p.userId,
                playerType: p.playerType,
                socketId: null
            });
        });

    io.to(lobby).emit('estado_chat', { activo: true, fightId });
    console.log(`[REST] Partida iniciada. fightId=${fightId} | jugadores=${players.length}`);
    res.status(200).json({ status: "success", fightId, players: players.length });
});

// ─── REST: FINALIZAR PARTIDA ──────────────────────────────────────────────────
app.post("/api/finalizar-partida", (req, res) => {
    partidaIniciada = false;
    fightId = null;
    authorizedPlayers.clear();
    warningCount.clear();
    io.to(lobby).emit('estado_chat', { activo: false });
    console.log("[REST] Partida finalizada");
    res.status(200).json({ status: "success", message: "Partida finalizada" });
});

// ─── REST: HISTORIAL DE MENSAJES ──────────────────────────────────────────────
app.get("/api/mensajes/:fid", async (req, res) => {
    try {
        const mensajes = await Mensaje.find({ fightId: req.params.fid })
            .sort({ timestamp: 1 })
            .limit(200);
        res.json(mensajes);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/status", (req, res) => {
    res.json({
        active: partidaIniciada,
        fightId,
        authorizedPlayers: authorizedPlayers.size
    });
});

// ─── SOCKET.IO AUTH ──────────────────────────────────────────────────────────
io.use((socket, next) => {
    if (!jwtSecret) return next();

    const authToken = socket.handshake.auth?.token
        || socket.handshake.headers.authorization?.replace("Bearer ", "");

    if (!authToken) return next();

    try {
        const payload = jwt.verify(authToken, jwtSecret);
        const userId = payload.sub || payload.userId;
        if (userId) socketToUser.set(socket.id, { userId, username: String(userId) });
    } catch (_) { /* token inválido, igual se permite conectar */ }
    return next();
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`Socket conectado: ${socket.id}`);

    // Estado inicial
    socket.emit('estado_chat', { activo: partidaIniciada, fightId });
    socket.join(lobby);
    actualizarYEnviarLista();

    // ── IDENTIFICAR USUARIO ────────────────────────────────────────────────
    socket.on('identificar', ({ userId, username }) => {
        const existing = socketToUser.get(socket.id);
        const effectiveUserId = existing?.userId || userId;
        if (!effectiveUserId) return;

        const displayName = username || existing?.username || effectiveUserId;
        socketToUser.set(socket.id, { userId: effectiveUserId, username: displayName });

        // Vincular socketId en authorizedPlayers si existe
        if (authorizedPlayers.has(effectiveUserId)) {
            const entry = authorizedPlayers.get(effectiveUserId);
            entry.socketId = socket.id;
            entry.username = displayName;
            authorizedPlayers.set(effectiveUserId, entry);
        }

        console.log(`[ID] ${socket.id} → userId=${effectiveUserId} username=${displayName}`);
        socket.emit('identificado', { ok: true, userId: effectiveUserId, username: displayName });
        actualizarYEnviarLista();

        if (!authorizedPlayers.has(effectiveUserId)) {
            socket.emit('voice_access_denied', { reason: 'No eres combatiente de esta pelea.' });
        }
    });
    socket.on('peer_ready', ({ peerId }) => {
        socket.peerId = peerId;
        actualizarYEnviarLista();
    });

    // ── TOGGLE MUTE LOCAL (sincronizar con sala) ───────────────────────────
    socket.on('toggle_mute_local', ({ mutedSelf }) => {
        if (!partidaIniciada || !isAuthorizedSocket(socket.id)) {
            socket.emit('voice_access_denied', { reason: 'Solo combatientes pueden usar voz.' });
            return;
        }
        const user = getUserFromSocket(socket.id);
        const name = user?.username || socket.id.substring(0, 5);
        socket.to(lobby).emit('peer_mute_changed', {
            socketId: socket.id,
            userId: user?.userId,
            username: name,
            muted: mutedSelf
        });
    });

    // ── CHAT + MODERACIÓN ─────────────────────────────────────────────────
    socket.on('chat message', async (msg) => {
        if (!partidaIniciada) {
            socket.emit('notificacion_sistema', "El chat está deshabilitado hasta que inicie la partida.");
            return;
        }

        if (!isAuthorizedSocket(socket.id)) {
            socket.emit('voice_access_denied', { reason: 'Solo combatientes pueden usar el chat de pelea.' });
            return;
        }

        if (!msg?.texto) return;

        const user = getUserFromSocket(socket.id);
        const userId = user?.userId || socket.id;
        const username = user?.username || `Usuario-${socket.id.substring(0, 5)}`;

        const { textoFiltrado, huboInfraccion } = procesarMensaje(msg.texto);
        msg.texto = textoFiltrado;
        msg.username = username;
        msg.userId = userId;

        // Persistir mensaje en MongoDB
        try {
            await new Mensaje({ fightId, userId, username, texto: textoFiltrado }).save();
        } catch (e) {
            console.error("[DB] Error guardando mensaje:", e.message);
        }

        emitToAuthorized('chat message', msg);

        // Gestionar infracción
        if (huboInfraccion) {
            const prev = warningCount.get(userId) || 0;
            const next = prev + 1;
            warningCount.set(userId, next);

            // Persistir advertencia
            try {
                await new Advertencia({ fightId, userId, username, texto: msg.texto, count: next }).save();
            } catch (e) {
                console.error("[DB] Error guardando advertencia:", e.message);
            }

            const mensajeAdvertencia = `⚠️ ${username} recibió advertencia ${next}/${MAX_WARNINGS} por lenguaje inapropiado.`;

            // Mostrar advertencia a toda la sala
            emitToAuthorized('advertencia_sistema', {
                userId,
                username,
                count: next,
                max: MAX_WARNINGS,
                mensaje: mensajeAdvertencia
            });

            // Notificar al infractor
            socket.emit('notificacion_sistema', `Advertencia ${next}/${MAX_WARNINGS}: lenguaje inapropiado detectado.`);

            // Al alcanzar el límite → silenciar micrófono
            if (next >= MAX_WARNINGS) {
                emitToAuthorized('comando_silenciar', socket.id);
                socket.emit('notificacion_sistema', "Tu micrófono ha sido desactivado permanentemente por reiteradas infracciones.");
                console.log(`[MUTE] ${username} (${userId}) alcanzó ${MAX_WARNINGS} advertencias → silenciado`);
            }
        }
    });

    // ── REPORTAR USUARIO ──────────────────────────────────────────────────
    socket.on('enviar_reporte', async ({ targetId, motivo }) => {
        if (!partidaIniciada || !isAuthorizedSocket(socket.id)) {
            socket.emit('voice_access_denied', { reason: 'Solo combatientes pueden reportar en pelea.' });
            return;
        }
        try {
            const user = getUserFromSocket(socket.id);
            await new Reporte({
                fightId,
                emisorId: user?.userId || socket.id,
                targetId,
                motivo
            }).save();
            console.log(`[DB] Reporte guardado contra: ${targetId}`);
            socket.emit('notificacion_sistema', "Reporte registrado con éxito.");
        } catch (e) {
            console.error("[DB] Error al guardar reporte:", e.message);
        }
    });

    // ── WEBRTC SIGNALING (solo combatientes) ──────────────────────────────
    socket.on('rtc-offer', ({ toUserId, offer }) => {
        if (!partidaIniciada || !isAuthorizedSocket(socket.id)) {
            socket.emit('voice_access_denied', { reason: 'No autorizado para señalización WebRTC.' });
            return;
        }

        const from = getUserFromSocket(socket.id);
        const targetSocketId = getAuthorizedSocketByUserId(toUserId);
        if (!from?.userId || !targetSocketId || !offer) return;

        io.to(targetSocketId).emit('rtc-offer', { fromUserId: from.userId, offer });
    });

    socket.on('rtc-answer', ({ toUserId, answer }) => {
        if (!partidaIniciada || !isAuthorizedSocket(socket.id)) {
            socket.emit('voice_access_denied', { reason: 'No autorizado para señalización WebRTC.' });
            return;
        }

        const from = getUserFromSocket(socket.id);
        const targetSocketId = getAuthorizedSocketByUserId(toUserId);
        if (!from?.userId || !targetSocketId || !answer) return;

        io.to(targetSocketId).emit('rtc-answer', { fromUserId: from.userId, answer });
    });

    socket.on('rtc-ice-candidate', ({ toUserId, candidate }) => {
        if (!partidaIniciada || !isAuthorizedSocket(socket.id)) {
            socket.emit('voice_access_denied', { reason: 'No autorizado para señalización WebRTC.' });
            return;
        }

        const from = getUserFromSocket(socket.id);
        const targetSocketId = getAuthorizedSocketByUserId(toUserId);
        if (!from?.userId || !targetSocketId || !candidate) return;

        io.to(targetSocketId).emit('rtc-ice-candidate', { fromUserId: from.userId, candidate });
    });

    // ── CONTROLES MANUALES (testing) ──────────────────────────────────────
    socket.on('iniciar_partida', () => {
        partidaIniciada = true;
        io.to(lobby).emit('estado_chat', { activo: true, fightId });
    });

    socket.on('finalizar_partida', () => {
        partidaIniciada = false;
        io.to(lobby).emit('estado_chat', { activo: false });
    });

    // ── ACTIVAR SALA POR FIGHTID ───────────────
    socket.on('join_fight', ({ fightId: fid, userId, username }) => {
        if (!fid || !userId) return;
        // Registrar usuario
        const effectiveUser = socketToUser.get(socket.id) || {};
        socketToUser.set(socket.id, {
            userId: effectiveUser.userId || userId,
            username: effectiveUser.username || username || userId
        });

        const effectiveUserId = effectiveUser.userId || userId;
        const displayName = effectiveUser.username || username || userId;

        if (!fightId || fightId !== String(fid)) {
            fightId = String(fid);
            partidaIniciada = true;
            warningCount.clear();
            console.log(`[SOCKET] Partida activada por join_fight. fightId=${fightId}`);
        }

        // Autorizar jugador
        if (!authorizedPlayers.has(effectiveUserId)) {
            authorizedPlayers.set(effectiveUserId, {
                username: displayName,
                playerType: 'PLAYER',
                socketId: socket.id
            });
        } else {
            const entry = authorizedPlayers.get(effectiveUserId);
            entry.socketId = socket.id;
            entry.username = displayName;
            authorizedPlayers.set(effectiveUserId, entry);
        }

        // Emitir estado a TODOS los de la sala
        io.to(lobby).emit('estado_chat', { activo: true, fightId });
        actualizarYEnviarLista();
        socket.emit('identificado', { ok: true, userId: effectiveUserId, username: displayName });
        console.log(`[JOIN_FIGHT] ${displayName} (${effectiveUserId}) → fightId=${fightId}`);
    });

    // ── DESCONEXIÓN ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const user = socketToUser.get(socket.id);
        if (user && authorizedPlayers.has(user.userId)) {
            const entry = authorizedPlayers.get(user.userId);
            if (entry.socketId === socket.id) {
                entry.socketId = null;
                authorizedPlayers.set(user.userId, entry);
            }
        }
        socketToUser.delete(socket.id);
        console.log(`Socket desconectado: ${socket.id}`);
        actualizarYEnviarLista();
    });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function actualizarYEnviarLista() {
    try {
        const sockets = await io.in(lobby).fetchSockets();
        const lista = sockets
            .map(s => {
                const user = socketToUser.get(s.id);
                return {
                    socketId: s.id,
                    userId: user?.userId || null,
                    username: user?.username || null,
                };
            })
            .filter(item => isAuthorizedUser(item.userId)); 
        emitToAuthorized('listaSockets', lista);
    } catch (e) {
        console.error("Error actualizando lista:", e);
    }
}

// ─── CONFIGURACIÓN DEL PUERTO (CORREGIDO) ──────────────────────────────────────
// Priorizamos el PORT del .env sobre cualquier cosa inyectada por el IDE
const PORT = process.env.PORT ? Number(process.env.PORT) : 3030;

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Servidor ejecutándose en: http://localhost:${PORT}`);
    console.log(`📡 Puerto detectado: ${process.env.PORT || 'Usando default 3030'}`);
    console.log(`🎮 Estado inicial: ${partidaIniciada ? 'ACTIVO' : 'ESPERANDO PARTIDA'}\n`);
    
    // Iniciamos RabbitMQ DESPUÉS de que el servidor y socket.io estén listos
    await connectRabbitMQ();
});
