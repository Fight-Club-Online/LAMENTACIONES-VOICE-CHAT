import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import mongoose from 'mongoose';

const app = express();
const server = createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });

const __dirname = dirname(fileURLToPath(import.meta.url));
const lobby = "sala-principal";

app.use(express.json());

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

mongoose.connect(mongoURI)
    .then(() => console.log("✅ Conectado a MongoDB Atlas: VOICE-CHAT"))
    .catch(err => console.error("❌ Error Mongo:", err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const Reporte = mongoose.model('Report', new mongoose.Schema({
    fightId:   String,
    emisorId:  String,
    targetId:  String,
    motivo:    String,
    fecha:     { type: Date, default: Date.now }
}), 'REPORT');

const Mensaje = mongoose.model('Message', new mongoose.Schema({
    fightId:   String,
    userId:    String,
    username:  String,
    texto:     String,
    timestamp: { type: Date, default: Date.now }
}), 'MESSAGES');

const Advertencia = mongoose.model('Warning', new mongoose.Schema({
    fightId:   String,
    userId:    String,
    username:  String,
    texto:     String,
    count:     Number,
    timestamp: { type: Date, default: Date.now }
}), 'WARNINGS');

// ─── FILTRO DE PALABRAS ───────────────────────────────────────────────────────
const PALABRAS_BANEADAS = ["tonto", "feo", "estupido", "maldito", "idiota", "bobada"];

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

    players.forEach(p => {
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

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`Socket conectado: ${socket.id}`);

    // Estado inicial
    socket.emit('estado_chat', { activo: partidaIniciada, fightId });
    socket.join(lobby);
    actualizarYEnviarLista();

    // ── IDENTIFICAR USUARIO ────────────────────────────────────────────────
    socket.on('identificar', ({ userId, username }) => {
        if (!userId) return;

        const displayName = username || userId;
        socketToUser.set(socket.id, { userId, username: displayName });

        // Vincular socketId en authorizedPlayers si existe
        if (authorizedPlayers.has(userId)) {
            const entry = authorizedPlayers.get(userId);
            entry.socketId = socket.id;
            entry.username = displayName;
            authorizedPlayers.set(userId, entry);
        }

        console.log(`[ID] ${socket.id} → userId=${userId} username=${displayName}`);
        socket.emit('identificado', { ok: true, userId, username: displayName });
    });

    // ── TOGGLE MUTE LOCAL (sincronizar con sala) ───────────────────────────
    socket.on('toggle_mute_local', ({ mutedSelf }) => {
        const user = getUserFromSocket(socket.id);
        const name = user?.username || socket.id.substring(0, 5);
        socket.to(lobby).emit('peer_mute_changed', {
            socketId: socket.id,
            userId:   user?.userId,
            username: name,
            muted:    mutedSelf
        });
    });

    // ── CHAT + MODERACIÓN ─────────────────────────────────────────────────
    socket.on('chat message', async (msg) => {
        if (!partidaIniciada) {
            socket.emit('notificacion_sistema', "El chat está deshabilitado hasta que inicie la partida.");
            return;
        }

        if (!msg?.texto) return;

        const user = getUserFromSocket(socket.id);
        const userId   = user?.userId   || socket.id;
        const username = user?.username || `Usuario-${socket.id.substring(0, 5)}`;

        const { textoFiltrado, huboInfraccion } = procesarMensaje(msg.texto);
        msg.texto = textoFiltrado;
        msg.username = username;
        msg.userId   = userId;

        // Persistir mensaje en MongoDB
        try {
            await new Mensaje({ fightId, userId, username, texto: textoFiltrado }).save();
        } catch (e) {
            console.error("[DB] Error guardando mensaje:", e.message);
        }

        io.to(lobby).emit('chat message', msg);

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
            io.to(lobby).emit('advertencia_sistema', {
                userId,
                username,
                count: next,
                max:   MAX_WARNINGS,
                mensaje: mensajeAdvertencia
            });

            // Notificar al infractor
            socket.emit('notificacion_sistema', `Advertencia ${next}/${MAX_WARNINGS}: lenguaje inapropiado detectado.`);

            // Al alcanzar el límite → silenciar micrófono
            if (next >= MAX_WARNINGS) {
                io.to(lobby).emit('comando_silenciar', socket.id);
                socket.emit('notificacion_sistema', "Tu micrófono ha sido desactivado permanentemente por reiteradas infracciones.");
                console.log(`[MUTE] ${username} (${userId}) alcanzó ${MAX_WARNINGS} advertencias → silenciado`);
            }
        }
    });

    // ── REPORTAR USUARIO ──────────────────────────────────────────────────
    socket.on('enviar_reporte', async ({ targetId, motivo }) => {
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

    // ── CONTROLES MANUALES (testing) ──────────────────────────────────────
    socket.on('iniciar_partida', () => {
        partidaIniciada = true;
        io.to(lobby).emit('estado_chat', { activo: true, fightId });
    });

    socket.on('finalizar_partida', () => {
        partidaIniciada = false;
        io.to(lobby).emit('estado_chat', { activo: false });
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
        const lista = sockets.map(s => {
            const user = socketToUser.get(s.id);
            return { socketId: s.id, userId: user?.userId || null, username: user?.username || null };
        });
        io.to(lobby).emit('listaSockets', lista);
    } catch (e) {
        console.error("Error actualizando lista:", e);
    }
}

// ─── CONFIGURACIÓN DEL PUERTO (CORREGIDO) ──────────────────────────────────────
// Priorizamos el PORT del .env sobre cualquier cosa inyectada por el IDE
const PORT = process.env.PORT ? Number(process.env.PORT) : 3030;

server.listen(PORT, () => {
    console.log(`\n🚀 Servidor ejecutándose en: http://localhost:${PORT}`);
    console.log(`📡 Puerto detectado: ${process.env.PORT || 'Usando default 3030'}`);
    console.log(`🎮 Estado inicial: ${partidaIniciada ? 'ACTIVO' : 'ESPERANDO PARTIDA'}\n`);
});