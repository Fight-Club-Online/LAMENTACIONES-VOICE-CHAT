import express from "express";
import dotenv from "dotenv";
dotenv.config();
import { createServer } from "node:http";
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import mongoose from 'mongoose';

const app = express();
const server = createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {} 
});

// --- CONFIGURACIÓN DE RUTAS Y MIDDLEWARE ---
const __dirname = dirname(fileURLToPath(import.meta.url));
const lobby = "sala-principal"; 

// 1. Middleware para que el servidor entienda JSON (Necesario para la integración con Java)
app.use(express.json());

// --- VARIABLE DE CONTROL DE ESTADO ---
// Se recomienda iniciar en 'false' para que el chat esté bloqueado por defecto
let partidaIniciada = false; 

// --- 1. CONFIGURACIÓN DE MONGODB ATLAS ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error("❌ MONGO_URI no definida. Revisa tu archivo .env");
    process.exit(1);
}

mongoose.connect(mongoURI)
    .then(() => console.log("✅ Conectado a MongoDB Atlas: VOICE-CHAT"))
    .catch(err => console.error("❌ Error en conexión Mongo:", err));

const Reporte = mongoose.model('Report', new mongoose.Schema({
    emisorId: String,
    targetId: String,
    motivo: String,
    fecha: { type: Date, default: Date.now }
}), 'REPORT');

// --- 2. SISTEMA DE BANEO Y FILTRADO ---
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

// --- 3. SERVIDOR DE ARCHIVOS ESTÁTICOS Y API ---
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

// --- NUEVO: ENDPOINTS DE CONTROL PARA FIGHT-SERVICE (JAVA) ---
app.post("/api/iniciar-partida", (req, res) => {
    partidaIniciada = true;
    // Emitimos a todos los clientes que el chat ahora está activo
    io.to(lobby).emit('estado_chat', { activo: true });
    
    console.log("[REST API] Señal recibida de Fight-Service: Chat HABILITADO");
    res.status(200).json({ status: "success", message: "Partida iniciada en el servidor de voz" });
});

app.post("/api/finalizar-partida", (req, res) => {
    partidaIniciada = false;
    io.to(lobby).emit('estado_chat', { activo: false });
    
    console.log("[REST API] Señal recibida: Chat DESHABILITADO");
    res.status(200).json({ status: "success", message: "Partida finalizada" });
});

// --- 4. LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);
    
    // --- APRETÓN DE MANOS INICIAL ---
    // Apenas el cliente se conecta, le enviamos el estado actual (importante para que el botón no sea gris si ya empezó)
    socket.emit('estado_chat', { activo: partidaIniciada });

    socket.join(lobby);
    actualizarYEnviarLista();

    // Eventos manuales (pueden usarse desde consola para testear)
    socket.on('iniciar_partida', () => {
        partidaIniciada = true;
        io.to(lobby).emit('estado_chat', { activo: true });
    });

    socket.on('finalizar_partida', () => {
        partidaIniciada = false;
        io.to(lobby).emit('estado_chat', { activo: false });
    });

    // --- EVENTO: REPORTAR USUARIO ---
    socket.on('enviar_reporte', async (data) => {
        try {
            const nuevoReporte = new Reporte({
                emisorId: socket.id,
                targetId: data.targetId,
                motivo: data.motivo
            });
            await nuevoReporte.save();
            console.log(`[DB] Reporte guardado para: ${data.targetId}`);
            socket.emit('notificacion_sistema', "Reporte registrado con éxito.");
        } catch (error) {
            console.error("Error al guardar reporte:", error);
        }
    });

    // --- EVENTO: CHAT Y MODERACIÓN (CON BLOQUEO DE ESTADO) ---
    socket.on('chat message', (msg) => {
        if (!partidaIniciada) {
            socket.emit('notificacion_sistema', "El chat está deshabilitado hasta que inicie la partida.");
            return; 
        }

        if (msg && msg.texto) {
            const resultado = procesarMensaje(msg.texto);
            msg.texto = resultado.textoFiltrado;
            io.to(lobby).emit('chat message', msg);

            if (resultado.huboInfraccion) {
                console.log(`[BAN] Silenciando a ${socket.id}`);
                io.to(lobby).emit('comando_silenciar', socket.id);
                socket.emit('notificacion_sistema', "Tu micrófono ha sido desactivado por lenguaje inapropiado.");
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.id}`);
        actualizarYEnviarLista();
    });
});

// --- 5. FUNCIONES AUXILIARES ---
async function actualizarYEnviarLista() {
    try {
        const sockets = await io.in(lobby).fetchSockets();
        const listaSocks = sockets.map(s => s.id);
        io.to(lobby).emit('listaSockets', listaSocks);
    } catch (error) {
        console.error("Error al actualizar lista:", error);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor en http://localhost:${PORT}`);
    console.log(`Estado inicial del chat: ${partidaIniciada ? 'ACTIVO' : 'ESPERANDO PARTIDA'}`);
});