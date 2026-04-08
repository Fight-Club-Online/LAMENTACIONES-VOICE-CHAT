import { socket } from './chat.js';

var peer = null;
var peerList = [];
let localStream = null;
let estaSilenciadoGlobal = false; 
let baneadoLocal = false; // Estado de baneo por conducta
let chatHabilitadoPorPartida = false; // CONTROL DE ESTADO DE PARTIDA

const llamada = document.getElementById("llamada");
const btnHablar = document.getElementById('btn-hablar');
const btnMute = document.getElementById('btn-mute');
const userUiList = document.getElementById('user-ui-list'); 
let listaUsuarios = [];

const TECLA_PTT = " "; 
let teclaPresionada = false;

// --- GESTIÓN DE ESTADO DE PARTIDA ---

socket.on('estado_chat', (estado) => {
    chatHabilitadoPorPartida = estado.activo;
    
    if (btnHablar) {
        if (chatHabilitadoPorPartida) {
            btnHablar.disabled = false;
            btnHablar.innerText = "Pulsar para Hablar";
            btnHablar.style.opacity = "1";
            btnHablar.style.cursor = "pointer";
            btnHablar.style.backgroundColor = "";
        } else {
            btnHablar.disabled = true;
            btnHablar.innerText = "Esperando partida...";
            btnHablar.style.opacity = "0.5";
            btnHablar.style.cursor = "not-allowed";
            desactivarMicrofono(); // Apagado de seguridad
        }
    }
    console.log(`[SISTEMA] Chat de voz ${chatHabilitadoPorPartida ? 'ACTIVADO' : 'DESACTIVADO'}`);
});

// --- INICIALIZACIÓN ---

socket.on('listaSockets', (lista) => {
    listaUsuarios = lista;
});

socket.on('connect', () => {
    init(socket.id);
});

window.init = function (userid) {
    if (peer) peer.destroy();
    peer = new Peer(userid);
    peer.on('open', (id) => console.log('Peer abierto con ID: ' + id));
    listenToCall();
}

// --- GESTIÓN DE MEDIA (AUDIO) ---

function obtenerMedia() {
    return new Promise((resolve, reject) => {
        if (localStream) {
            resolve(localStream);
        } else {
            const constraints = { 
                video: false,
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            };
            navigator.mediaDevices.getUserMedia(constraints)
                .then((stream) => {
                    stream.getAudioTracks()[0].enabled = false;
                    localStream = stream;
                    addLocalAudio(stream);
                    resolve(stream);
                })
                .catch(err => reject(err));
        }
    });
}

// --- LÓGICA DE CONTROL DEL MICRÓFONO (PTT) ---

function activarMicrofono() {
    // BLOQUEO 1: Por baneo de conducta
    if (baneadoLocal) {
        if (btnHablar) {
            btnHablar.innerText = "¡BLOQUEADO!";
            btnHablar.style.backgroundColor = "#b0bec5";
        }
        return;
    }

    // BLOQUEO 2: Por estado de la partida
    if (!chatHabilitadoPorPartida) return;

    if (localStream && !estaSilenciadoGlobal) {
        localStream.getAudioTracks()[0].enabled = true;
        btnHablar.style.backgroundColor = "#ff5722";
        btnHablar.innerText = "Hablando...";
    }
}

function desactivarMicrofono() {
    if (localStream) {
        localStream.getAudioTracks()[0].enabled = false;
        // Restaurar texto según estado
        if (baneadoLocal) {
            btnHablar.innerText = "¡BLOQUEADO!";
            btnHablar.style.backgroundColor = "#b0bec5";
        } else if (!chatHabilitadoPorPartida) {
            btnHablar.innerText = "Esperando partida...";
            btnHablar.style.backgroundColor = "";
        } else {
            btnHablar.innerText = "Pulsar para Hablar";
            btnHablar.style.backgroundColor = ""; 
        }
    }
}

// --- EVENTOS DE CONTROL (TECLADO, MOUSE, TOUCH) ---

document.addEventListener('keydown', (e) => {
    if (e.key === TECLA_PTT && !teclaPresionada) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        teclaPresionada = true;
        activarMicrofono();
    }
});

document.addEventListener('keyup', (e) => {
    if (e.key === TECLA_PTT) {
        teclaPresionada = false;
        desactivarMicrofono();
    }
});

if (btnHablar) {
    btnHablar.addEventListener('mousedown', activarMicrofono);
    btnHablar.addEventListener('mouseup', desactivarMicrofono);
    btnHablar.addEventListener('touchstart', (e) => { e.preventDefault(); activarMicrofono(); });
    btnHablar.addEventListener('touchend', (e) => { e.preventDefault(); desactivarMicrofono(); });
}

// --- SISTEMA DE MODERACIÓN Y REPORTES ---

socket.on('comando_silenciar', (idUsuarioMalportado) => {
    const elAudio = document.getElementById(`audio-${idUsuarioMalportado}`);
    if (elAudio) {
        elAudio.muted = true;
        console.warn(`Silenciando a ${idUsuarioMalportado} por conducta inapropiada`);
        actualizarInterfazUsuarios();
    }
});

socket.on('notificacion_sistema', (msg) => {
    // Si el servidor detecta baneo, bloqueamos localmente
    if (msg.includes("desactivado") || msg.includes("conducta")) {
        baneadoLocal = true;
        estaSilenciadoGlobal = true;
        desactivarMicrofono(); 
        if (btnMute) btnMute.disabled = true; 
    }
    console.warn("Mensaje del sistema:", msg);
});

// --- LÓGICA DE LLAMADAS (PEERJS) ---

function listenToCall() {
    peer.on('call', (call) => {
        obtenerMedia().then((stream) => {
            call.answer(stream);
            call.on('stream', (remoteStream) => gestionarNuevoStream(remoteStream, call.peer));
        });
    });
}

llamada.addEventListener('click', (e) => {
    e.preventDefault();
    // Solo permitir llamadas si la partida inició
    if (!chatHabilitadoPorPartida) {
        alert("Espera a que inicie la partida para llamar.");
        return;
    }
    listaUsuarios.forEach(userId => {
        if (socket.id !== userId) makeCall(userId);
    });
});

window.makeCall = function (receiverID) {
    obtenerMedia().then((stream) => {
        let call = peer.call(receiverID, stream);
        call.on('stream', (remoteStream) => gestionarNuevoStream(remoteStream, call.peer));
    });
}

function gestionarNuevoStream(stream, peerID) {
    if (!peerList.includes(peerID)) {
        peerList.push(peerID);
        addRemoteAudio(stream, peerID);
        actualizarInterfazUsuarios();
    }
}

// --- BOTÓN MUTE MANUAL (LOCAL) ---

if (btnMute) {
    btnMute.addEventListener('click', () => {
        if (!localStream || baneadoLocal) return;

        estaSilenciadoGlobal = !estaSilenciadoGlobal;
        if (estaSilenciadoGlobal) {
            localStream.getAudioTracks()[0].enabled = false;
            btnMute.innerText = "Activar Micro";
            btnMute.style.backgroundColor = "#f44336";
            btnHablar.style.opacity = "0.5";
        } else {
            btnMute.innerText = "Silenciar Micro";
            btnMute.style.backgroundColor = "#607d8b";
            btnHablar.style.opacity = "1";
        }
    });
}

// --- GESTIÓN DE DOM (AUDIOS Y UI) ---

function addLocalAudio(stream) {
    if (document.getElementById('local-audio')) return;
    const audio = document.createElement('audio');
    audio.id = 'local-audio';
    audio.srcObject = stream;
    audio.muted = true; 
    audio.autoplay = true;
    document.body.appendChild(audio);
}

function addRemoteAudio(stream, peerID) {
    let audio = document.getElementById(`audio-${peerID}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${peerID}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
    }
    audio.srcObject = stream;
}

function actualizarInterfazUsuarios() {
    if (!userUiList) return;
    userUiList.innerHTML = ''; 

    peerList.forEach(peerID => {
        const li = document.createElement('li');
        li.style.padding = "10px";
        li.style.borderBottom = "1px solid #444";
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";

        const nombre = document.createElement('span');
        nombre.innerText = `User: ${peerID.substring(0, 6)}...`;

        const containerButtons = document.createElement('div');

        // Botón Silenciar (Local/Mute Personal)
        const btnMuteInd = document.createElement('button');
        btnMuteInd.className = 'btn-small-mute';
        const elAudio = document.getElementById(`audio-${peerID}`);
        const isMuted = elAudio ? elAudio.muted : false;
        btnMuteInd.innerText = isMuted ? "Escuchar" : "Silenciar";
        btnMuteInd.style.backgroundColor = isMuted ? "#ff9800" : "#607d8b";

        btnMuteInd.onclick = () => {
            if (elAudio) {
                elAudio.muted = !elAudio.muted;
                btnMuteInd.innerText = elAudio.muted ? "Escuchar" : "Silenciar";
                btnMuteInd.style.backgroundColor = elAudio.muted ? "#ff9800" : "#607d8b";
            }
        };

        // Botón Reportar (Hacia MongoDB Atlas)
        const btnReportar = document.createElement('button');
        btnReportar.innerText = "Reportar";
        btnReportar.style.backgroundColor = "#d32f2f";
        btnReportar.style.color = "white";
        btnReportar.style.marginLeft = "8px";
        btnReportar.style.border = "none";
        btnReportar.style.padding = "4px 8px";
        btnReportar.style.borderRadius = "4px";
        btnReportar.style.cursor = "pointer";

        btnReportar.onclick = () => {
            const motivo = prompt(`Motivo del reporte para ${peerID.substring(0, 5)}:`);
            if (motivo && motivo.trim() !== "") {
                socket.emit('enviar_reporte', {
                    targetId: peerID,
                    motivo: motivo
                });
                alert("Reporte enviado con éxito.");
            }
        };

        containerButtons.appendChild(btnMuteInd);
        containerButtons.appendChild(btnReportar);
        
        li.appendChild(nombre);
        li.appendChild(containerButtons);
        userUiList.appendChild(li);
    });
}