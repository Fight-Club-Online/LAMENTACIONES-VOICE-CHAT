const vcSocket = io("http://localhost:3000", {
    transports: ['websocket'],
    upgrade: false
});

const btnHablar = document.getElementById('btn-hablar'); 

let mediaRecorder;
let localStream;

navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then((stream) => {
        localStream = stream;
        localStream.getAudioTracks()[0].enabled = false;
        console.log("Micrófono vinculado y en espera (PTT)");
    })
    .catch(err => console.error("Error al acceder al micrófono:", err));

if (btnHablar) {
    btnHablar.addEventListener('mousedown', () => {
        if (!localStream) return;

        localStream.getAudioTracks()[0].enabled = true;

        mediaRecorder = new MediaRecorder(localStream);
        
        mediaRecorder.addEventListener('dataavailable', async (event) => {
            if (event.data.size > 0 && vcSocket.connected) {
                const audioData = await event.data.arrayBuffer();
                vcSocket.emit('audioStream', audioData);
            }
        });

        mediaRecorder.start(100); 
        btnHablar.style.backgroundColor = "#4CAF50"; 
        btnHablar.innerText = "Hablando...";
    });

    btnHablar.addEventListener('mouseup', () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            if (localStream) {
                localStream.getAudioTracks()[0].enabled = false;
            }
            btnHablar.style.backgroundColor = ""; 
            btnHablar.innerText = "Mantener para Hablar";
        }
    });

    btnHablar.addEventListener('touchstart', (e) => { 
        e.preventDefault(); 
        btnHablar.dispatchEvent(new Event('mousedown')); 
    });
    btnHablar.addEventListener('touchend', () => { 
        btnHablar.dispatchEvent(new Event('mouseup')); 
    });
}

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let siguienteFragmento = 0;

vcSocket.on('audioStream', async (audioData) => {
    try {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        const audioDataDecodificado = await audioCtx.decodeAudioData(audioData);
        const fuente = audioCtx.createBufferSource();
        fuente.buffer = audioDataDecodificado;
        fuente.connect(audioCtx.destination);

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