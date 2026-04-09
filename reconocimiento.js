import { socket } from './chat.js';

let reconocimiento;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const btnHablar         = document.getElementById('btn-hablar');
let texto            = '';
let teclaPresionada  = false;

// ─── DATOS DEL USUARIO LOCAL ──────────────────────────────────────────────────
function getLocalUser() {
    try {
        const raw = localStorage.getItem('user_data');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

// ─── CONTROL DE ESTADO DE PARTIDA ─────────────────────────────────────────────
let chatHabilitadoPorPartida = false;

socket.on('estado_chat', (estado) => {
    chatHabilitadoPorPartida = estado.activo;
    if (!chatHabilitadoPorPartida && reconocimiento) {
        console.log("[RECONOCIMIENTO] Deshabilitado: esperando partida.");
        try { reconocimiento.stop(); } catch (_) {}
    } else if (chatHabilitadoPorPartida) {
        console.log("[RECONOCIMIENTO] Habilitado: partida en curso.");
    }
});

// ─── SPEECH RECOGNITION ───────────────────────────────────────────────────────
if (SpeechRecognition) {
    console.log("Sistema de reconocimiento listo");
    reconocimiento = new SpeechRecognition();
    reconocimiento.lang            = 'es-ES';
    reconocimiento.continuous      = true;
    reconocimiento.interimResults  = true;

    reconocimiento.onresult = (event) => {
        if (!chatHabilitadoPorPartida) return;

        let textoTemporal = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            textoTemporal += event.results[i][0].transcript;
        }
        texto = textoTemporal;
        console.log("Procesando voz:", texto);

        // Auto-envío si el buffer supera 150 caracteres
        if (texto.length >= 150) {
            emitirMensajeDeVoz(texto);
            texto = '';
        }
    };

    reconocimiento.onerror = (event) => {
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
            console.error('Error de reconocimiento:', event.error);
        }
    };

    reconocimiento.onend = () => console.log("Reconocimiento finalizado");

    // ── EMITIR CON userId y username ─────────────────────────────────────────
    function emitirMensajeDeVoz(contenido) {
        if (!contenido?.trim()) return;
        const localUser = getLocalUser();
        socket.emit('chat message', {
            id:       socket.id,
            userId:   localUser?.userId   || socket.id,
            username: localUser?.username || null,
            texto:    contenido
        });
    }

    // ── INICIO / FIN DE CAPTURA ───────────────────────────────────────────────
    const iniciarCaptura = () => {
        if (!chatHabilitadoPorPartida) return;
        texto = '';
        try { reconocimiento.start(); } catch (_) {}
    };

    const finalizarYEnviar = () => {
        if (chatHabilitadoPorPartida && texto.trim().length > 0) {
            emitirMensajeDeVoz(texto);
        }
        try { reconocimiento.stop(); } catch (_) {}
        texto = '';
    };

    // ── BOTÓN PTT ─────────────────────────────────────────────────────────────
    if (btnHablar) {
        btnHablar.addEventListener('mousedown', iniciarCaptura);
        btnHablar.addEventListener('mouseup',   finalizarYEnviar);
        btnHablar.addEventListener('touchstart', (e) => { e.preventDefault(); iniciarCaptura(); });
        btnHablar.addEventListener('touchend',   (e) => { e.preventDefault(); finalizarYEnviar(); });
    }

    // ── TECLADO ESPACIO (PTT) ─────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.key === " " && !teclaPresionada &&
            e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
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
    console.log("Este navegador no soporta Web Speech API");
}