const vcSocket = io("http://localhost:3000", {
    transports: ['websocket'],
    upgrade: false
});

const btnHablar = document.getElementById('btn-hablar'); 

let mediaRecorder;
let localStream;

// 1. Solicitar acceso al micrófono una sola vez
navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then((stream) => {
        localStream = stream;
        // IMPORTANTE: Mantener el track desactivado al inicio para evitar fugas de audio
        localStream.getAudioTracks()[0].enabled = false;
        console.log("Micrófono vinculado y en espera (PTT)");
    })
    .catch(err => console.error("Error al acceder al micrófono:", err));

// 2. LÓGICA PARA ENVIAR (Push-to-Talk)
if (btnHablar) {
    btnHablar.addEventListener('mousedown', () => {
        if (!localStream) return;

        // Activamos el track de audio justo antes de empezar a grabar
        localStream.getAudioTracks()[0].enabled = true;

        mediaRecorder = new MediaRecorder(localStream);
        
        mediaRecorder.addEventListener('dataavailable', async (event) => {
            // Solo enviamos si el socket está conectado y hay datos
            if (event.data.size > 0 && vcSocket.connected) {
                const audioData = await event.data.arrayBuffer();
                vcSocket.emit('audioStream', audioData);
            }
        });

        mediaRecorder.start(100); // Fragmentos de 100ms para baja latencia
        btnHablar.style.backgroundColor = "#4CAF50"; 
        btnHablar.innerText = "Hablando...";
    });

    btnHablar.addEventListener('mouseup', () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            // Desactivamos el track de audio al soltar para silencio absoluto
            if (localStream) {
                localStream.getAudioTracks()[0].enabled = false;
            }
            btnHablar.style.backgroundColor = ""; 
            btnHablar.innerText = "Mantener para Hablar";
        }
    });

    // Soporte para dispositivos móviles
    btnHablar.addEventListener('touchstart', (e) => { 
        e.preventDefault(); 
        btnHablar.dispatchEvent(new Event('mousedown')); 
    });
    btnHablar.addEventListener('touchend', () => { 
        btnHablar.dispatchEvent(new Event('mouseup')); 
    });
}

// 3. LÓGICA PARA RECIBIR Y REPRODUCIR
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let siguienteFragmento = 0;

vcSocket.on('audioStream', async (audioData) => {
    try {
        // El audioContext debe estar en estado 'running' (política de Chrome)
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        const audioDataDecodificado = await audioCtx.decodeAudioData(audioData);
        const fuente = audioCtx.createBufferSource();
        fuente.buffer = audioDataDecodificado;
        fuente.connect(audioCtx.destination);

        // Sincronización temporal para evitar ruidos de estática entre fragmentos
        const tiempoActual = audioCtx.currentTime;
        if (siguienteFragmento < tiempoActual) {
            siguienteFragmento = tiempoActual;
        }

        fuente.start(siguienteFragmento);
        siguienteFragmento += audioDataDecodificado.duration;
    } catch (e) {
        console.error("Error al decodificar audio entrante", e);
    }
});