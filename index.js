import dotenv from "dotenv";
dotenv.config();
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
        const rabbitUrl = process.env.RABBITMQ_URL ||
            `amqp://${process.env.RABBITMQ_USERNAME || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@${process.env.RABBITMQ_HOST || 'localhost'}:${process.env.RABBITMQ_PORT || 5672}`;
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        const queues = ['fight.user.registered.queue', 'fight.guest.registered.queue'];

        for (const queue of queues) {
            await channel.assertQueue(queue, { durable: true });
            console.log(`[*] Escuchando en: ${queue}`);

            channel.consume(queue, (msg) => {
                if (msg !== null) {
                    const content = JSON.parse(msg.content.toString());
                    console.log(`[EVENTO] Recibido de ${queue}:`, content);

                    const roomId = content.gameId || content.roomId;
                    if (roomId) {
                        const fid = String(roomId);
                        console.log(`[RABBIT] Activando pelea: ${fid}`);
                        const fight = getFight(fid);
                        fight.active = true;
                        io.to(`fight:${fid}`).emit('estado_chat', { activo: true, fightId: fid });
                        scheduleListaUpdate(fid, 500);
                    }

                    channel.ack(msg);
                }
            }, { noAck: false });
        }
    } catch (error) {
        console.error("Error en RabbitMQ:", error);
    }
}

const app = express();
const server = createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {},
    cors: {
        origin: [
            process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
            'https://lamentaciones-frontend.vercel.app',
            'http://localhost:5173',
        ],
        methods: ['GET', 'POST'],
        credentials: true,
    },
    transports: ['polling', 'websocket'],
});

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ESTADO GLOBAL MÍNIMO 
const socketToUser = new Map();
const socketToFight = new Map();
const mutedRelations = new Map();

// ─── ESTADO POR SALA ──────────────────────────────────────────────────────────
const fights = new Map();

function getFight(fid) {
    if (!fights.has(fid)) {
        fights.set(fid, {
            authorizedPlayers: new Map(), // userId → { username, playerType, socketId }
            connectedUsers: new Map(), // userId → { username, playerType, socketId }
            warningCount: new Map(),
            chatWarningCount: new Map(),
            voiceWarningCount: new Map(),
            active: true
        });
    }
    return fights.get(fid);
}

// Devuelve el fight y fightId del socket, o null si no está en ninguna sala
function getFightForSocket(socketId) {
    const fid = socketToFight.get(socketId);
    if (!fid) return null;
    return { fid, fight: getFight(fid) };
}

const MAX_WARNINGS = 3;

// ─── DEBOUNCE POR SALA ────────────────────────────────────────────────────────
const _listaTimers = new Map(); // fightId → timer

function scheduleListaUpdate(fid, delay = 350) {
    if (_listaTimers.has(fid)) clearTimeout(_listaTimers.get(fid));
    _listaTimers.set(fid, setTimeout(() => actualizarYEnviarLista(fid), delay));
}

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
    reporterUsername: { type: String, default: null },
    targetId: String,
    reportedUsername: { type: String, default: null },
    motivo: String,
    evidenceMessages: { type: Array, default: null },
    fecha: { type: Date, default: Date.now }
}), 'REPORT');

const Mensaje = mongoose.model('Message', new mongoose.Schema({
    fightId: String,
    userId: String,
    username: String,
    texto: String,
    source: { type: String, enum: ['CHAT', 'VOICE'], default: 'CHAT' },
    timestamp: { type: Date, default: Date.now }
}), 'MESSAGES');

const Advertencia = mongoose.model('Warning', new mongoose.Schema({
    fightId: String,
    userId: String,
    username: String,
    texto: String,
    count: Number,
    source: { type: String, enum: ['CHAT', 'VOICE'], default: 'CHAT' },
    timestamp: { type: Date, default: Date.now }
}), 'WARNINGS');

// ─── FILTRO DE PALABRAS ───────────────────────────────────────────────────────
const PALABRAS_BANEADAS = [
    // Español general
    "tonto", "feo", "spam", "maldito", "idiota", "estupido", "imbecil", "bobada",
    "mierda", "puta", "puto", "cabron", "hijueputa", "hp", "culero", "pendejo",
    "maricon", "hdp", "gonorrea", "malparido", "mongolo", "retrasado", "inutil",
    "bastardo", "desgraciado", "subnormal", "gilipollas", "cagada", "perra", "zorra",
    // Español Colombia / Latam
    "guevon", "huevon", "paraco", "sapo", "mamon", "marica", "chimbo", "hijuemadre",
    "verraco", "soplamocos", "cagon", "pirobo", "malparida", "ojete", "chimbada",
    "canalla", "lambon", "zanahoria", "nojoda", "mameluco", "bobo", "bruto",
    // Español España
    "joder", "hostia", "cono", "capullo", "mamon", "hijo de puta",
    "me cago", "follar", "putada",
    // Ingles
    "fuck", "shit", "bitch", "asshole", "damn", "crap", "idiot", "moron",
    "loser", "bastard", "dumbass", "dickhead", "motherfucker", "prick",
    "wanker", "twat", "cunt", "scumbag", "retard", "jerk", "douche",
    "piss", "bollocks", "slut", "whore",
    // Variaciones con caracteres sustituidos
    "h1jueputa", "hij0eputa", "c4bron", "m1erda", "put4", "b1tch", "sh1t",
];

function normalizarTexto(t) {
    return t ? t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';
}

function procesarMensaje(texto) {
    if (!texto) return { textoFiltrado: "", huboInfraccion: false };
    const textoNorm = normalizarTexto(texto);
    let textoFiltrado = textoNorm;
    let huboInfraccion = false;
    PALABRAS_BANEADAS.forEach(palabra => {
        const palabraNorm = normalizarTexto(palabra);
        const regex = new RegExp(`\\b${palabraNorm}\\b`, 'gi');
        if (regex.test(textoFiltrado)) huboInfraccion = true;
        textoFiltrado = textoFiltrado.replace(regex, "****");
    });
    return { textoFiltrado, huboInfraccion };
}

function getSocketByUserId(userId) {
    for (const [socketId, user] of socketToUser.entries()) {
        if (user.userId === userId) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket && socket.connected) return socket;
        }
    }
    return null;
}

function getUserFromSocket(socketId) {
    return socketToUser.get(socketId) || null;
}

function findSocketByUserId(targetUserId) {
    for (const [socketId, user] of socketToUser.entries()) {
        if (user.userId === targetUserId) return socketId;
    }
    return null;
}

// ─── HELPERS SCOPED A UN FIGHT ────────────────────────────────────────────────
function isAuthorizedSocket(socketId, fight) {
    const user = getUserFromSocket(socketId);
    if (!user?.userId) return false;
    return fight.authorizedPlayers.has(user.userId);
}

function isConnectedSocket(socketId, fight) {
    const user = getUserFromSocket(socketId);
    if (!user?.userId) return false;
    return fight.authorizedPlayers.has(user.userId) || fight.connectedUsers.has(user.userId);
}

function emitToFightRoom(fid, event, payload) {
    io.to(`fight:${fid}`).emit(event, payload);
}

function emitToAuthorized(fight, fid, event, payload) {
    for (const [, entry] of fight.authorizedPlayers.entries()) {
        if (entry.socketId) io.to(entry.socketId).emit(event, payload);
    }
}

// ─── ESTÁTICOS ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(join(__dirname, 'index.html')));

// ─── REST: INICIAR PARTIDA ────────────────────────────────────────────────────
app.post("/api/iniciar-partida", (req, res) => {
    const { fightId: fid, players } = req.body;
    if (!fid || !Array.isArray(players)) {
        return res.status(400).json({ status: "error", message: "fightId y players son requeridos" });
    }

    const fight = getFight(String(fid));
    fight.active = true;
    fight.authorizedPlayers.clear();
    fight.warningCount.clear();

    players
        .filter(p => p?.playerType === "PLAYER")
        .forEach(p => {
            fight.authorizedPlayers.set(p.userId, {
                username: p.username || p.userId,
                playerType: p.playerType,
                socketId: null
            });
        });

    io.to(`fight:${fid}`).emit('estado_chat', { activo: true, fightId: fid });
    console.log(`[REST] Partida iniciada. fightId=${fid} | jugadores=${players.length}`);
    res.status(200).json({ status: "success", fightId: fid, players: players.length });
});

// ─── REST: FINALIZAR PARTIDA ──────────────────────────────────────────────────
app.post("/api/finalizar-partida", (req, res) => {
    const { fightId: fid } = req.body;
    if (!fid) return res.status(400).json({ status: "error", message: "fightId requerido" });

    const fight = getFight(String(fid));
    fight.active = false;
    io.to(`fight:${fid}`).emit('estado_chat', { activo: false });
    fights.delete(String(fid));
    console.log(`[REST] Partida finalizada. fightId=${fid}`);
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
    const status = {};
    for (const [fid, fight] of fights.entries()) {
        status[fid] = { active: fight.active, players: fight.authorizedPlayers.size };
    }
    res.json({ fights: status });
});

// Historial completo de infracciones de un jugador para módulo de supervisión
app.get("/api/advertencias/usuario/:userId", async (req, res) => {
    try {
        const advertencias = await Advertencia.find({ userId: req.params.userId })
            .sort({ timestamp: -1 })
            .limit(200);
        res.json({
            userId: req.params.userId,
            totalInfracciones: advertencias.length,
            porFuente: {
                CHAT: advertencias.filter(a => a.source === 'CHAT').length,
                VOICE: advertencias.filter(a => a.source === 'VOICE').length,
            },
            historial: advertencias
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Advertencias por pelea supervisión en tiempo real de una partida
app.get("/api/advertencias/:fid", async (req, res) => {
    try {
        const advertencias = await Advertencia.find({ fightId: req.params.fid })
            .sort({ timestamp: 1 })
            .limit(500);
        res.json(advertencias);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    } catch (_) { }
    return next();
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`Socket conectado: ${socket.id}`);

    // Estado inicial: sin sala aún
    socket.emit('estado_chat', { activo: false, fightId: null });

    // ── JOIN FIGHT ─────────────────────────────────────────────────────────
    socket.on('join_fight', ({ fightId: fid, userId, username, playerType = 'PLAYER' }) => {
        if (!fid || !userId) return;

        const fightRoom = `fight:${fid}`;
        socket.join(fightRoom);
        socketToFight.set(socket.id, fid); // ← registrar en qué sala está este socket

        const fight = getFight(fid);
        const isPlayer = playerType === 'PLAYER';

        const existing = socketToUser.get(socket.id) || {};
        const effectiveUserId = userId || existing.userId;
        const displayName = username || existing.username || userId;

        socketToUser.set(socket.id, {
            userId: effectiveUserId,
            username: displayName,
            playerType: isPlayer ? 'PLAYER' : 'SPECTATOR'
        });

        // Si bajó de PLAYER a SPECTATOR, sacarlo de authorizedPlayers
        if (!isPlayer && fight.authorizedPlayers.has(effectiveUserId)) {
            fight.authorizedPlayers.delete(effectiveUserId);
            console.log(`[JOIN_FIGHT] ${effectiveUserId} degradado a SPECTATOR`);
        }

        if (isPlayer) {
            if (!fight.authorizedPlayers.has(effectiveUserId)) {
                fight.authorizedPlayers.set(effectiveUserId, {
                    username: displayName,
                    playerType: 'PLAYER',
                    socketId: socket.id
                });
            } else {
                const entry = fight.authorizedPlayers.get(effectiveUserId);
                entry.socketId = socket.id;
                entry.username = displayName;
            }
        }

        fight.connectedUsers.set(effectiveUserId, {
            username: displayName,
            playerType: isPlayer ? 'PLAYER' : 'SPECTATOR',
            socketId: socket.id
        });

        socket.emit('identificado', {
            ok: true,
            userId: effectiveUserId,
            username: displayName,
            playerType: isPlayer ? 'PLAYER' : 'SPECTATOR'
        });

        socket.emit('estado_chat', { activo: fight.active, fightId: fid });

        if (!isPlayer) {
            socket.emit('voice_access_denied', { reason: 'No eres combatiente de esta pelea.' });
        }

        scheduleListaUpdate(fid, 400);

        const activePlayers = [...fight.authorizedPlayers.values()].filter(p => p.socketId);
        if (activePlayers.length >= 2) {
            setTimeout(() => {
                console.log(`[PEERS_READY] Ambos jugadores listos en fightId=${fid}`);
                io.to(`fight:${fid}`).emit('peers_ready', {
                    players: [...fight.authorizedPlayers.keys()]
                });
            }, 600); 
        }

        const chatStrikes = fight.chatWarningCount.get(effectiveUserId) || 0;
        const voiceStrikes = fight.voiceWarningCount.get(effectiveUserId) || 0;
        if (chatStrikes >= MAX_WARNINGS) {
            socket.emit('player_strike', { count: chatStrikes, max: MAX_WARNINGS, source: 'CHAT', userId: effectiveUserId, username: displayName });
            socket.emit('notificacion_sistema', 'Tu chat escrito sigue bloqueado por infracciones anteriores.');
        }
        if (voiceStrikes >= MAX_WARNINGS) {
            socket.emit('player_strike', { count: voiceStrikes, max: MAX_WARNINGS, source: 'VOICE', userId: effectiveUserId, username: displayName });
            socket.emit('comando_silenciar', socket.id);
            socket.emit('notificacion_sistema', 'Tu micrófono sigue bloqueado por infracciones anteriores.');
        }
        console.log(`[JOIN_FIGHT] ${displayName} (${effectiveUserId}) [${isPlayer ? 'PLAYER' : 'SPECTATOR'}] → fightId=${fid}`);
    });

    // ── IDENTIFICAR (fallback sin fight) ──────────────────────────────────
    socket.on('identificar', ({ userId, username }) => {
        const existing = socketToUser.get(socket.id);
        const effectiveUserId = existing?.userId || userId;
        if (!effectiveUserId) return;
        const displayName = username || existing?.username || effectiveUserId;

        socketToUser.set(socket.id, {
            userId: effectiveUserId,
            username: displayName,
            playerType: existing?.playerType || 'SPECTATOR'
        });

        // Actualizar socketId en el fight si ya está en uno
        const ctx = getFightForSocket(socket.id);
        if (ctx) {
            const { fid, fight } = ctx;
            if (fight.authorizedPlayers.has(effectiveUserId)) {
                const entry = fight.authorizedPlayers.get(effectiveUserId);
                entry.socketId = socket.id;
                entry.username = displayName;
            }
            scheduleListaUpdate(fid);
        }

        socket.emit('identificado', { ok: true, userId: effectiveUserId, username: displayName });
    });

    // ── TOGGLE MUTE LOCAL ──────────────────────────────────────────────────
    socket.on('toggle_mute_local', ({ mutedSelf }) => {
        const ctx = getFightForSocket(socket.id);
        if (!ctx || !isAuthorizedSocket(socket.id, ctx.fight)) {
            socket.emit('voice_access_denied', { reason: 'Solo combatientes pueden usar voz.' });
            return;
        }
        const user = getUserFromSocket(socket.id);
        const name = user?.username || socket.id.substring(0, 5);
        io.to(`fight:${ctx.fid}`).emit('peer_mute_changed', {
            socketId: socket.id,
            userId: user?.userId,
            username: name,
            muted: mutedSelf
        });
    });

    // ── CHAT + MODERACIÓN ─────────────────────────────────────────────────
    socket.on('chat message', async (msg) => {
        const ctx = getFightForSocket(socket.id);

        // Validar sala activa
        if (!ctx || !ctx.fight.active) {
            socket.emit(
                'notificacion_sistema',
                "El chat está deshabilitado hasta que inicie la partida."
            );
            return;
        }

        // Solo combatientes autorizados
        if (!isAuthorizedSocket(socket.id, ctx.fight)) {
            socket.emit(
                'voice_access_denied',
                { reason: 'Solo combatientes pueden usar el chat de pelea.' }
            );
            return;
        }

        if (!msg?.texto?.trim()) return;

        const { fid, fight } = ctx;

        const user = getUserFromSocket(socket.id);
        const userId = user?.userId || socket.id;
        const username = user?.username || `Usuario-${socket.id.substring(0, 5)}`;

        // Filtrar lenguaje ofensivo
        const { textoFiltrado, huboInfraccion } = procesarMensaje(msg.texto);

        // Objeto que se enviará al frontend
        const mensajeEnviar = {
            fightId: fid,
            userId,
            username,
            texto: textoFiltrado,
            source: 'CHAT',
            timestamp: new Date()
        };

        // Guardar historial en MongoDB
        try {
            await new Mensaje({
                fightId: fid,
                userId,
                username,
                texto: textoFiltrado,
                source: 'CHAT'
            }).save();
        } catch (e) {
            console.error("[DB] Error guardando mensaje:", e.message);
        }

        // Emitir mensaje a toda la pelea
        io.to(`fight:${fid}`).emit('chat message', mensajeEnviar);

        // Moderación por insultos
        if (huboInfraccion) {
            const prev = fight.chatWarningCount.get(userId) || 0;
            const next = prev + 1;

            fight.chatWarningCount.set(userId, next);
            try {
                await new Advertencia({
                    fightId: fid,
                    userId,
                    username,
                    texto: textoFiltrado,
                    count: next,
                    source: 'CHAT'
                }).save();
            } catch (e) {
                console.error("[DB] Error guardando advertencia:", e.message);
            }

            // Strike privado — solo al infractor
            socket.emit('player_strike', { count: next, max: MAX_WARNINGS, userId, username, source: 'CHAT' });

            // Aviso general
            emitToAuthorized(fight, fid, 'advertencia_sistema', {
                userId,
                username,
                count: next,
                max: MAX_WARNINGS,
                mensaje: `⚠️ Un combatiente recibió advertencia ${next}/${MAX_WARNINGS}.`
            });

            socket.emit(
                'notificacion_sistema',
                `Strike ${next}/${MAX_WARNINGS}: lenguaje inapropiado detectado.`
            );

            // Ban automático
            if (next >= MAX_WARNINGS) {
                io.to(`fight:${fid}`).emit('player_banned', {
                    userId,
                    username,
                    fightId: fid,
                    reason: 'infracciones_repetidas',
                    timestamp: new Date().toISOString()
                });

                socket.emit(
                    'notificacion_sistema',
                    "Tu chat escrito ha sido desactivado permanentemente por infracciones."
                );

                try {
                    const evidenceMessages = await Mensaje.find({ fightId: fid })
                    .sort({ timestamp: -1 }).limit(10).lean();
                    const lastWarnings = await Advertencia.find({ fightId: fid, userId })
                    .sort({ timestamp: -1 }).limit(5).lean();
                    await new Reporte({
                        fightId: fid,
                        emisorId: 'SISTEMA',
                        reporterUsername: 'AUTO_BAN',
                        targetId: userId,
                        reportedUsername: username,
                        motivo: `Ban automático por ${MAX_WARNINGS} strikes de CHAT. Último texto: "${textoFiltrado}"`,
                        evidenceMessages: [...evidenceMessages, ...lastWarnings],
                        fecha: new Date()
                    }).save();
                    console.log(`[AUTO_REPORTE] Generado contra ${username} por ban de chat`);
                } catch (e) {
                    console.error('[AUTO_REPORTE] Error:', e.message);
                }
                
                console.log(
                    `[BAN_EVENT] ${username} (${userId}) alcanzó ${MAX_WARNINGS} strikes de CHAT`
                );
            }
        }
    });

    // ── MODERACIÓN DE VOZ transcripción del cliente
    socket.on('voice_transcript', async ({ texto }) => {
        const ctx = getFightForSocket(socket.id);
        if (!ctx || !isAuthorizedSocket(socket.id, ctx.fight)) return;
        if (!texto?.trim()) return;
        if (!ctx.fight.active) return;

        const user = getUserFromSocket(socket.id);
        const userId = user?.userId || socket.id;
        const username = user?.username || socket.id.substring(0, 8);
        const entryVoice = ctx.fight.authorizedPlayers.get(userId);
        if (!entryVoice || entryVoice.playerType !== 'PLAYER') return;
        const { textoFiltrado, huboInfraccion } = procesarMensaje(texto);
        
        if (!huboInfraccion) return;

        const { fid, fight } = ctx;
        const prev = fight.voiceWarningCount.get(userId) || 0;
        const next = prev + 1;
        fight.voiceWarningCount.set(userId, next);

        console.log(`[VOICE_MOD] Infracción de voz detectada: "${texto}" → Strike ${next}/${MAX_WARNINGS} para ${username}`);
        try {
            await new Advertencia({ fightId: fid, userId, username, texto: textoFiltrado, count: next, source: 'VOICE' }).save();
        } catch (e) {
            console.error("[DB] Error guardando advertencia de voz:", e.message);
        }
        // Strike privado al infractor
        socket.emit('player_strike', { count: next, max: MAX_WARNINGS, userId, username, source: 'VOICE' });
        socket.emit('notificacion_sistema', `Strike ${next}/${MAX_WARNINGS} (voz): lenguaje inapropiado detectado.`);

        if (next >= MAX_WARNINGS) {
            io.to(`fight:${fid}`).emit('player_banned', {
                userId,
                username,
                fightId: fid,
                reason: 'infracciones_repetidas_voz',
                timestamp: new Date().toISOString(),
            });

            emitToAuthorized(fight, fid, 'comando_silenciar', socket.id);

            // Reporte automático por ban de voz
            try {
                const evidenceMessages = await Mensaje.find({ fightId: fid })
                .sort({ timestamp: -1 }).limit(10).lean();
                const lastWarnings = await Advertencia.find({ fightId: fid, userId })
                .sort({ timestamp: -1 }).limit(5).lean();
                await new Reporte({
                    fightId: fid,
                    emisorId: 'SISTEMA',
                    reporterUsername: 'AUTO_BAN',
                    targetId: userId,
                    reportedUsername: username,
                    motivo: `Ban automático por ${MAX_WARNINGS} strikes de VOZ. Último texto detectado: "${textoFiltrado}"`,
                    evidenceMessages: [...evidenceMessages, ...lastWarnings],
                    fecha: new Date()
                }).save();
                console.log(`[AUTO_REPORTE] Generado contra ${username} por ban de voz`);
            } catch (e) {
                console.error('[AUTO_REPORTE] Error:', e.message);
            }
            
            socket.emit('notificacion_sistema', "Tu micrófono ha sido desactivado permanentemente por infracciones de voz.");
            console.log(`[BAN_EVENT_VOZ] ${username} baneado por voz tras ${MAX_WARNINGS} strikes`);
        }
    });

    


    // ── REPORTAR USUARIO ──────────────────────────────────────────────────
    socket.on('enviar_reporte', async ({ targetId, motivo }) => {
        const ctx = getFightForSocket(socket.id);

        if (!ctx || !isAuthorizedSocket(socket.id, ctx.fight)) {
            socket.emit('voice_access_denied', {
                reason: 'Solo combatientes pueden reportar en pelea.'
            });
            return;
        }

        try {
            const user = getUserFromSocket(socket.id);

            const reporterUsername = user?.username || null;

            const targetSocketId = findSocketByUserId(targetId);
            const targetUser = targetSocketId
                ? getUserFromSocket(targetSocketId)
                : null;

            const reportedUsername = targetUser?.username || null;

            const evidenceMessages = await Mensaje.find({
                fightId: ctx.fid
            })
                .sort({ timestamp: -1 })
                .limit(10)
                .lean();

            await new Reporte({
                fightId: ctx.fid,
                emisorId: user?.userId || socket.id,
                reporterUsername,

                targetId,
                reportedUsername,

                motivo,
                evidenceMessages
            }).save();

            socket.emit(
                'notificacion_sistema',
                "Reporte registrado con éxito."
            );

            console.log(`[DB] Reporte guardado contra ${targetId}`);

        } catch (e) {
            console.error("[DB] Error al guardar reporte:", e.message);
        }
    });
    // ── SILENCIAR USUARIO (MANUAL) ────────────────────────────────────────
    socket.on('silenciar_usuario', ({ targetSocketId }) => {
        const ctx = getFightForSocket(socket.id);
        if (!ctx || !isAuthorizedSocket(socket.id, ctx.fight)) {
            socket.emit('voice_access_denied', { reason: 'No autorizado para silenciar.' });
            return;
        }
        if (!targetSocketId) return;
        const user = getUserFromSocket(socket.id);
        const targetUser = getUserFromSocket(targetSocketId);
        console.log(`[MOD] ${user?.username} silenció a ${targetUser?.username}`);
        io.to(targetSocketId).emit('comando_silenciar', targetSocketId);
        socket.emit('notificacion_sistema', `🔇 Has silenciado a ${targetUser?.username || 'usuario'}`);
    });

    socket.on('mute_user', ({ targetUserId }) => {
        const fromUser = getUserFromSocket(socket.id);
        if (!fromUser?.userId || !targetUserId) return;
        if (fromUser.userId === targetUserId) return;

        if (!mutedRelations.has(fromUser.userId)) {
            mutedRelations.set(fromUser.userId, new Set());
        }
        const mySet = mutedRelations.get(fromUser.userId);
        const willMute = !mySet.has(targetUserId);

        if (willMute) mySet.add(targetUserId);
        else mySet.delete(targetUserId);

        socket.emit('mute_updated', { targetUserId, muted: willMute });
        console.log(`[MUTE] ${fromUser.userId} ${willMute ? 'silenció' : 'reactivó'} a ${targetUserId} (local)`);
    });

    // ── WEBRTC SIGNALING ──────────────────────────────────────────────────
    socket.on('rtc-offer', ({ toUserId, offer }) => {
        const ctx = getFightForSocket(socket.id);
        const from = getUserFromSocket(socket.id);
        if (!ctx || !isConnectedSocket(socket.id, ctx.fight)) {
            socket.emit('voice_access_denied', { reason: 'No autorizado.' });
            return;
        }
        if (!from?.userId || !offer) return;

        const forwardOffer = (attempts = 0) => {
            const targetSocketId = findSocketByUserId(toUserId);
            if (targetSocketId) {
                console.log(`[RTC-OFFER] ${from.userId} → ${toUserId} (intento ${attempts + 1})`);
                io.to(targetSocketId).emit('rtc-offer', { fromUserId: from.userId, offer });
                return;
            }
            if (attempts < 5) {
                console.log(`[RTC-OFFER] Socket de ${toUserId} no encontrado, reintentando en 500ms...`);
                setTimeout(() => forwardOffer(attempts + 1), 500);
            } else {
                console.warn(`[RTC-OFFER] No se encontró socket de ${toUserId} tras 5 intentos`);
            }
        };
        forwardOffer();
    });

    socket.on('rtc-answer', ({ toUserId, answer }) => {
        const ctx = getFightForSocket(socket.id);
        const from = getUserFromSocket(socket.id);
        const targetSocketId = findSocketByUserId(toUserId);
        if (!ctx || !isConnectedSocket(socket.id, ctx.fight)) return;
        if (!from?.userId || !targetSocketId || !answer) return;
        console.log(`[RTC-ANSWER] ${from.userId} → ${toUserId}`);
        io.to(targetSocketId).emit('rtc-answer', { fromUserId: from.userId, answer });
    });

    socket.on('rtc-ice-candidate', ({ toUserId, candidate }) => {
        const ctx = getFightForSocket(socket.id);
        const from = getUserFromSocket(socket.id);
        const targetSocketId = findSocketByUserId(toUserId);
        if (!ctx || !isConnectedSocket(socket.id, ctx.fight)) return;
        if (!from?.userId || !targetSocketId || !candidate) return;
        io.to(targetSocketId).emit('rtc-ice-candidate', { fromUserId: from.userId, candidate });
    });

    // ── CONTROLES MANUALES (testing) ──────────────────────────────────────
    socket.on('iniciar_partida', ({ fightId: fid }) => {
        if (!fid) return;
        const fight = getFight(fid);
        fight.active = true;
        io.to(`fight:${fid}`).emit('estado_chat', { activo: true, fightId: fid });
    });

    socket.on('finalizar_partida', ({ fightId: fid }) => {
        if (!fid) return;
        const fight = getFight(fid);
        fight.active = false;
        io.to(`fight:${fid}`).emit('estado_chat', { activo: false });
    });

    // ── DESCONEXIÓN ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const user = socketToUser.get(socket.id);
        const fid = socketToFight.get(socket.id);

        if (user && fid) {
            const fight = fights.get(fid);
            if (fight) {
                if (fight.authorizedPlayers.has(user.userId)) {
                    const entry = fight.authorizedPlayers.get(user.userId);
                    if (entry.socketId === socket.id) entry.socketId = null;
                }
                if (fight.connectedUsers.has(user.userId)) {
                    const entry = fight.connectedUsers.get(user.userId);
                    if (entry.socketId === socket.id) {
                        if (user.playerType === 'SPECTATOR') fight.connectedUsers.delete(user.userId);
                        else entry.socketId = null;
                    }
                }
            }
            scheduleListaUpdate(fid);
        }

        if (user?.userId) {
            mutedRelations.delete(user.userId);
            for (const set of mutedRelations.values()) set.delete(user.userId);
        }

        socketToUser.delete(socket.id);
        socketToFight.delete(socket.id);
        console.log(`Socket desconectado: ${socket.id}`);
    });
});

// ─── HELPER: ENVIAR LISTA DE USUARIOS DEL FIGHT ───────────────────────────────
async function actualizarYEnviarLista(fid) {
    try {
        const fight = fights.get(fid);
        if (!fight) return;

        const fightRoom = `fight:${fid}`;
        const sockets = await io.in(fightRoom).fetchSockets();

        const lista = sockets
            .map(s => {
                const user = socketToUser.get(s.id);
                return {
                    socketId: s.id,
                    userId: user?.userId || null,
                    username: user?.username || null,
                    playerType: user?.playerType || 'SPECTATOR'
                };
            })
            .filter(item =>
                item.userId &&
                (fight.authorizedPlayers.has(item.userId) || fight.connectedUsers.has(item.userId))
            );

        console.log(`[LISTA][${fid}] Enviando:`, lista.map(l => `${l.userId}[${l.playerType}]`));

        io.to(fightRoom).emit('listaSockets', lista);
    } catch (e) {
        console.error("Error actualizando lista:", e);
    }
}

// ─── PUERTO ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ? Number(process.env.PORT) : 3030;

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Servidor ejecutándose en: http://localhost:${PORT}`);
    console.log(`📡 Puerto detectado: ${process.env.PORT || 'Usando default 3030'}`);
    console.log(`🎮 Estado inicial: sin peleas activas\n`);
    await connectRabbitMQ();
});
