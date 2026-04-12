// Asegúrate que el puerto coincida con tu servidor de voz (ej. 3030)
const vcSocket = io("http://localhost:3030", {
    transports: ['websocket']
});

const btnHablar = document.getElementById('btn-hablar'); 
let mediaRecorder;
let localStream;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let siguienteFragmento = 0;

// Inicializar micrófono
navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
        localStream = stream;
        // Mantener pistas desactivadas hasta que se presione el botón
        localStream.getAudioTracks().forEach(track => track.enabled = false);
    })
    .catch(err => console.error("Error micrófono:", err));

if (btnHablar) {
    const startRecording = async () => {
        if (!localStream) return;
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        localStream.getAudioTracks()[0].enabled = true;
        
        // Usamos un formato compatible (opus es estándar para web)
        mediaRecorder = new MediaRecorder(localStream, { mimeType: 'audio/webm;codecs=opus' });
        
        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && vcSocket.connected) {
                const audioData = await event.data.arrayBuffer();
                vcSocket.emit('audioStream', audioData);
            }
        };

        mediaRecorder.start(100); // Enviar trozos cada 100ms
        btnHablar.classList.add('active'); // Usa clases en lugar de estilos inline
        btnHablar.innerText = "Hablando...";
    };

    const stopRecording = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            if (localStream) {
                localStream.getAudioTracks()[0].enabled = false;
            }
            btnHablar.classList.remove('active');
            btnHablar.innerText = "Mantener para Hablar";
        }
    };

    // Eventos Mouse
    btnHablar.addEventListener('mousedown', startRecording);
    window.addEventListener('mouseup', stopRecording); // Mejor en window por si el mouse sale del botón

    // Eventos Touch (Mobile)
    btnHablar.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startRecording();
    });
    btnHablar.addEventListener('touchend', stopRecording);
}

// Recibir audio de otros
vcSocket.on('audioStream', async (audioData) => {
    try {
        const decodedData = await audioCtx.decodeAudioData(audioData);
        const source = audioCtx.createBufferSource();
        source.buffer = decodedData;
        source.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        // Si el tiempo programado ya pasó, resetear al tiempo actual
        if (siguienteFragmento < now) {
            siguienteFragmento = now;
        }

        source.start(siguienteFragmento);
        siguienteFragmento += decodedData.duration;
    } catch (e) {
        // Ignorar errores de decodificación de fragmentos incompletos al soltar el botón
    }
});