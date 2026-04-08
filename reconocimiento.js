import { socket } from './chat.js'

let reconocimiento;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const btnHablar = document.getElementById('btn-hablar'); 
let texto = '';
let teclaPresionada = false; 

// --- VARIABLE DE CONTROL DE ESTADO (INGENIERÍA) ---
let chatHabilitadoPorPartida = false;

// Escuchamos si la partida inició o terminó para habilitar el reconocimiento
socket.on('estado_chat', (estado) => {
    chatHabilitadoPorPartida = estado.activo;
    if (!chatHabilitadoPorPartida) {
        console.log("[RECONOCIMIENTO] Deshabilitado: Esperando inicio de partida.");
        if (reconocimiento) reconocimiento.stop(); 
    } else {
        console.log("[RECONOCIMIENTO] Habilitado: Partida en curso.");
    }
});

if (SpeechRecognition) {
    console.log("Sistema de reconocimiento listo");
    reconocimiento = new SpeechRecognition();
    reconocimiento.lang = 'es-ES';
    reconocimiento.continuous = true;
    reconocimiento.interimResults = true;

    reconocimiento.onresult = (event) => {
        // Bloqueo preventivo si la partida no ha iniciado
        if (!chatHabilitadoPorPartida) return;

        let textoTemporal = ''; 
        for (let i = event.resultIndex; i < event.results.length; i++) {
            textoTemporal += event.results[i][0].transcript;
        }
        
        texto = textoTemporal; 
        console.log("Procesando voz:", texto);

        // Envío automático si el buffer es muy largo (150 caracteres)
        if (texto.length >= 150) {
            socket.emit('chat message', {
                id: socket.id,
                texto: texto   
            });
            texto = '';
        }
    }

    reconocimiento.onerror = (event) => {
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
            console.error('Error de reconocimiento:', event.error);
        }
    };

    reconocimiento.onend = () => {
        console.log("Reconocimiento finalizado");
    };

    const iniciarCaptura = () => {
        // No iniciar si la partida no ha comenzado
        if (!chatHabilitadoPorPartida) return;

        texto = ''; 
        try {
            reconocimiento.start();
        } catch (e) {
            // Evita errores si ya está iniciado
        }
    };

    const finalizarYEnviar = () => {
        // Solo enviar si hay texto y la partida permite el chat
        if (chatHabilitadoPorPartida && texto.trim().length > 0) {
            socket.emit('chat message', {
                id: socket.id,
                texto: texto 
            });
        }
        try {
            reconocimiento.stop();
        } catch (e) {}
        texto = '';
    };

    // --- EVENTOS DE INTERFAZ (MOUSE / TOUCH) ---
    if (btnHablar) {
        btnHablar.addEventListener('mousedown', iniciarCaptura);
        btnHablar.addEventListener('mouseup', finalizarYEnviar);
        
        btnHablar.addEventListener('touchstart', (e) => { 
            e.preventDefault(); 
            iniciarCaptura(); 
        });
        btnHablar.addEventListener('touchend', (e) => { 
            e.preventDefault(); 
            finalizarYEnviar(); 
        });
    }

    // --- EVENTOS DE TECLADO (ESPACIO / PTT) ---
    document.addEventListener('keydown', (e) => {
        // Solo activamos si es la tecla espacio, no estamos en un input y la partida inició
        if (e.key === " " && !teclaPresionada && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            if (!chatHabilitadoPorPartida) return;
            teclaPresionada = true;
            iniciarCaptura();
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.key === " ") {
            teclaPresionada = false;
            finalizarYEnviar();
        }
    });

} else {
    console.log("Navegador no soporta Web Speech API");
}