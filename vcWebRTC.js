import { socket } from './chat.js';

var peer = null;
var peerList = [];
let localStream = null;
let estaSilenciadoGlobal = false; 
let baneadoLocal = false;

const llamada = document.getElementById("llamada");
const btnHablar = document.getElementById('btn-hablar');
const btnMute = document.getElementById('btn-mute');
const userUiList = document.getElementById('user-ui-list'); 
let listaUsuarios = [];

const TECLA_PTT = " "; 
let teclaPresionada = false;


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


function activarMicrofono() {
    if (baneadoLocal) {
        if (btnHablar) {
            btnHablar.innerText = "¡BLOQUEADO!";
            btnHablar.style.backgroundColor = "#b0bec5";
        }
        return;
    }

    if (localStream && !estaSilenciadoGlobal) {
        localStream.getAudioTracks()[0].enabled = true;
        btnHablar.style.backgroundColor = "#ff5722";
        btnHablar.innerText = "Hablando...";
    }
}

function desactivarMicrofono() {
    if (localStream) {
        localStream.getAudioTracks()[0].enabled = false;
        btnHablar.style.backgroundColor = baneadoLocal ? "#b0bec5" : ""; 
        btnHablar.innerText = baneadoLocal ? "¡BLOQUEADO!" : "Pulsar para Hablar";
    }
}

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


socket.on('comando_silenciar', (idUsuarioMalportado) => {
    const elAudio = document.getElementById(`audio-${idUsuarioMalportado}`);
    if (elAudio) {
        elAudio.muted = true;
        console.warn(`Silenciando a ${idUsuarioMalportado} por conducta inapropiada`);
        actualizarInterfazUsuarios();
    }
});

socket.on('notificacion_sistema', (msg) => {
    baneadoLocal = true;
    estaSilenciadoGlobal = true;
    desactivarMicrofono(); 
    
    if (btnMute) btnMute.disabled = true; 
    console.error("Acceso a micrófono restringido por el sistema.");
});

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
        const nombre = document.createElement('span');
        nombre.innerText = `User: ${peerID.substring(0, 6)}...`;

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

        li.appendChild(nombre);
        li.appendChild(btnMuteInd);
        userUiList.appendChild(li);
    });
}