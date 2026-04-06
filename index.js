import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';

const app = express();
const server = createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {} 
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const lobby = "sala-principal"; 

const PALABRAS_BANEADAS = ["tonto", "feo", "estupido", "maldito", "idiota", "bobada"];

/**
 * Procesa el mensaje: detecta infracciones y censura el texto.
 * Es vital que este proceso ocurra en el servidor para evitar bypasses.
 */
function procesarMensaje(texto) {
    if (!texto) return { textoFiltrado: "", huboInfraccion: false };
    
    let textoFiltrado = texto;
    let huboInfraccion = false;

    PALABRAS_BANEADAS.forEach(palabra => {
        const regex = new RegExp(`\\b${palabra}\\b`, 'gi');
        
        if (regex.test(texto)) {
            huboInfraccion = true;
        }
        
        textoFiltrado = textoFiltrado.replace(regex, "****");
    });

    return { textoFiltrado, huboInfraccion };
}

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});


io.on('connection', (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);

    socket.join(lobby);
    actualizarYEnviarLista();

    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.id}`);
        actualizarYEnviarLista();
    });

    /**
     * Manejo centralizado de mensajes (Voz y Texto)
     * Ambos llegan aquí bajo el evento 'chat message'
     */
    socket.on('chat message', (msg) => {
        if (msg && msg.texto) {
            const resultado = procesarMensaje(msg.texto);
            
            msg.texto = resultado.textoFiltrado;

            io.to(lobby).emit('chat message', msg);

            if (resultado.huboInfraccion) {
                console.log(`[MODERACIÓN] Silenciando a ${socket.id} por infracción detectada.`);
                io.to(lobby).emit('comando_silenciar', socket.id);
                socket.emit('notificacion_sistema', "Has sido silenciado automáticamente por lenguaje inapropiado.");
            }
        }
    });
    socket.on('audioStream', (audioData) => {
        socket.broadcast.emit('audioStream', audioData);
    });
});

async function actualizarYEnviarLista() {
    try {
        const sockets = await io.in(lobby).fetchSockets();
        const listaSocks = sockets.map(s => s.id);
        
        io.in(lobby).emit('listaSockets', listaSocks);
        console.log("Usuarios en línea:", listaSocks.length);
    } catch (error) {
        console.error("Error al actualizar la lista de sockets:", error);
    }
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n--- Servidor de Ingeniería Listo ---`);
    console.log(`Corriendo en: http://localhost:${PORT}`);
    console.log(`Moderación activa con ${PALABRAS_BANEADAS.length} palabras clave.\n`);
});