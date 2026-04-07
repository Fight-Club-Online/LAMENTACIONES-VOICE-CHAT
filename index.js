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

const __dirname = dirname(fileURLToPath(import.meta.url));
const lobby = "sala-principal"; 

// --- 1. CONFIGURACIÓN DE MONGODB ATLAS ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error("❌ MONGO_URI no está definida. Revisa tu archivo .env");
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

// --- 2. SISTEMA DE BANEO (LÓGICA) ---
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

// --- 3. SERVIDOR DE ARCHIVOS ESTÁTICOS ---
app.use(express.static(__dirname));
app.get("/", (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

// --- 4. LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);
    socket.join(lobby);
    actualizarYEnviarLista();

    // Evento: Reportar Usuario (Guardado en Atlas)
    socket.on('enviar_reporte', async (data) => {
        try {
            const nuevoReporte = new Reporte({
                emisorId: socket.id,
                targetId: data.targetId,
                motivo: data.motivo
            });
            await nuevoReporte.save();
            console.log(`[DB] Reporte guardado para el usuario: ${data.targetId}`);
            socket.emit('notificacion_sistema', "Reporte registrado con éxito.");
        } catch (error) {
            console.error("Error al guardar reporte:", error);
        }
    });

    // Evento: Chat y Moderación Automática
    socket.on('chat message', (msg) => {
        if (msg && msg.texto) {
            const resultado = procesarMensaje(msg.texto);
            msg.texto = resultado.textoFiltrado;

            // Enviamos el mensaje (censurado) a todos
            io.to(lobby).emit('chat message', msg);

            // Si detectamos infracción, silenciamos al usuario
            if (resultado.huboInfraccion) {
                console.log(`[BAN] Silenciando a ${socket.id}`);
                io.to(lobby).emit('comando_silenciar', socket.id);
                socket.emit('notificacion_sistema', "Tu micrófono ha sido desactivado por conducta inapropiada.");
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor en http://localhost:${PORT}`);
});