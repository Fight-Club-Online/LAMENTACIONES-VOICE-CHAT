import { socket } from './chat.js';

var peer = null;
var peerList = [];
let localStream = null;
let estaSilenciadoGlobal = false;
let baneadoLocal = false;
let chatHabilitadoPorPartida = false;

const llamada     = document.getElementById("llamada");
const btnHablar   = document.getElementById('btn-hablar');
const btnMute     = document.getElementById('btn-mute');
const userUiList  = document.getElementById('user-ui-list');

// Mapa socketId → { userId, username }
let listaUsuarios = [];

const TECLA_PTT = " ";
let teclaPresionada = false;

// ─── BANNER DE ADVERTENCIA ───────────────────────────────────────────────────
function mostrarBannerAdvertencia({ username, count, max, mensaje }) {
    let banner = document.getElementById('__advertencia-banner__');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = '__advertencia-banner__';
        Object.assign(banner.style, {
            position:       'fixed',
            top:            '70px',
            left:           '50%',
            transform:      'translateX(-50%)',
            zIndex:         '9999',
            backgroundColor:'#7f1d1d',
            color:          '#fecaca',
            border:         '2px solid #ef4444',
            borderRadius:   '12px',
            padding:        '14px 24px',
            fontFamily:     'sans-serif',
            fontSize:       '14px',
            fontWeight:     'bold',
            maxWidth:       '480px',
            textAlign:      'center',
            boxShadow:      '0 4px 20px rgba(239,68,68,0.4)',
            transition:     'opacity 0.4s'
        });
        document.body.appendChild(banner);
    }

    banner.innerText = mensaje || `⚠️ ${username} – Advertencia ${count}/${max}`;
    banner.style.opacity = '1';
    banner.style.display = 'block';

    clearTimeout(banner.__timer);
    banner.__timer = setTimeout(() => {
        banner.style.opacity = '0';
        setTimeout(() => { banner.style.display = 'none'; }, 400);
    }, 5000);
}

// ─── IDENTIFICAR USUARIO AL SERVIDOR ─────────────────────────────────────────
function identificarUsuario() {
    try {
        const raw = localStorage.getItem('user_data');
        if (!raw) return;
        const { userId, username } = JSON.parse(raw);
        if (!userId) return;
        socket.emit('identificar', { userId, username: username || userId });
        console.log(`[WS] Identificado como userId=${userId} username=${username}`);
    } catch (e) {
        console.error('[WS] Error leyendo user_data:', e);
    }
}

socket.on('connect', () => {
    identificarUsuario();
    init(socket.id);
});

// ─── ESTADO DE PARTIDA ────────────────────────────────────────────────────────
socket.on('estado_chat', (estado) => {
    chatHabilitadoPorPartida = estado.activo;
    if (btnHablar) {
        if (chatHabilitadoPorPartida) {
            btnHablar.disabled    = false;
            btnHablar.innerText   = "Pulsar para Hablar";
            btnHablar.style.opacity = '1';
            btnHablar.style.cursor  = 'pointer';
            btnHablar.style.backgroundColor = '';
        } else {
            btnHablar.disabled    = true;
            btnHablar.innerText   = "Esperando partida...";
            btnHablar.style.opacity = '0.5';
            btnHablar.style.cursor  = 'not-allowed';
            desactivarMicrofono();
        }
    }
    console.log(`[SISTEMA] Chat de voz ${chatHabilitadoPorPartida ? 'ACTIVADO' : 'DESACTIVADO'}`);
});

// ─── LISTA DE SOCKETS ─────────────────────────────────────────────────────────
socket.on('listaSockets', (lista) => {
    listaUsuarios = lista; // [{ socketId, userId, username }]
});

// ─── ADVERTENCIA DESDE SERVIDOR ───────────────────────────────────────────────
socket.on('advertencia_sistema', (data) => {
    mostrarBannerAdvertencia(data);

    // Agregar al chat como notificación visual
    const messages = document.getElementById('messages');
    if (messages) {
        const item = document.createElement('li');
        item.style.textAlign  = 'center';
        item.style.margin     = '10px 0';
        item.style.listStyle  = 'none';
        item.innerHTML = `
            <span style="background:#7f1d1d;color:#fecaca;padding:5px 15px;border-radius:20px;font-size:0.82rem;border:1px solid #ef4444;font-style:italic;">
                ⚠️ <strong>Advertencia:</strong> ${data.mensaje}
            </span>`;
        messages.appendChild(item);
    }
});

// ─── PEER MUTE SYNC ───────────────────────────────────────────────────────────
socket.on('peer_mute_changed', ({ socketId, muted }) => {
    const elAudio = document.getElementById(`audio-${socketId}`);
    if (elAudio) elAudio.muted = muted;
    actualizarInterfazUsuarios();
});

// ─── PEER INIT ────────────────────────────────────────────────────────────────
socket.on('listaSockets', (lista) => { listaUsuarios = lista; });

window.init = function (userid) {
    if (peer) peer.destroy();
    peer = new Peer(userid);
    peer.on('open', (id) => console.log('Peer abierto con ID: ' + id));
    listenToCall();
};

// ─── MEDIA ────────────────────────────────────────────────────────────────────
function obtenerMedia() {
    return new Promise((resolve, reject) => {
        if (localStream) { resolve(localStream); return; }
        navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        }).then((stream) => {
            stream.getAudioTracks()[0].enabled = false;
            localStream = stream;
            addLocalAudio(stream);
            resolve(stream);
        }).catch(reject);
    });
}

// ─── CONTROL MICRÓFONO (PTT) ──────────────────────────────────────────────────
function activarMicrofono() {
    if (baneadoLocal) {
        if (btnHablar) { btnHablar.innerText = "¡BLOQUEADO!"; btnHablar.style.backgroundColor = '#b0bec5'; }
        return;
    }
    if (!chatHabilitadoPorPartida) return;
    if (localStream && !estaSilenciadoGlobal) {
        localStream.getAudioTracks()[0].enabled = true;
        if (btnHablar) { btnHablar.style.backgroundColor = '#ff5722'; btnHablar.innerText = "Hablando..."; }
    }
}

function desactivarMicrofono() {
    if (localStream) localStream.getAudioTracks()[0].enabled = false;
    if (!btnHablar) return;
    if (baneadoLocal) {
        btnHablar.innerText = "¡BLOQUEADO!"; btnHablar.style.backgroundColor = '#b0bec5';
    } else if (!chatHabilitadoPorPartida) {
        btnHablar.innerText = "Esperando partida..."; btnHablar.style.backgroundColor = '';
    } else {
        btnHablar.innerText = "Pulsar para Hablar"; btnHablar.style.backgroundColor = '';
    }
}

// ─── EVENTOS DE TECLADO / MOUSE / TOUCH ──────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === TECLA_PTT && !teclaPresionada) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        teclaPresionada = true;
        activarMicrofono();
    }
});
document.addEventListener('keyup', (e) => {
    if (e.key === TECLA_PTT) { teclaPresionada = false; desactivarMicrofono(); }
});
if (btnHablar) {
    btnHablar.addEventListener('mousedown', activarMicrofono);
    btnHablar.addEventListener('mouseup',   desactivarMicrofono);
    btnHablar.addEventListener('touchstart', (e) => { e.preventDefault(); activarMicrofono(); });
    btnHablar.addEventListener('touchend',   (e) => { e.preventDefault(); desactivarMicrofono(); });
}

// ─── BOTÓN MUTE GLOBAL ────────────────────────────────────────────────────────
if (btnMute) {
    btnMute.addEventListener('click', () => {
        if (!localStream || baneadoLocal) return;
        estaSilenciadoGlobal = !estaSilenciadoGlobal;

        if (estaSilenciadoGlobal) {
            localStream.getAudioTracks()[0].enabled = false;
            btnMute.innerText = "Activar Micro";
            btnMute.style.backgroundColor = '#f44336';
            if (btnHablar) btnHablar.style.opacity = '0.5';
        } else {
            btnMute.innerText = "Silenciar Micro";
            btnMute.style.backgroundColor = '#607d8b';
            if (btnHablar) btnHablar.style.opacity = '1';
        }

        // Sincronizar estado de mute con el servidor
        socket.emit('toggle_mute_local', { mutedSelf: estaSilenciadoGlobal });
    });
}

// ─── MODERACIÓN ───────────────────────────────────────────────────────────────
socket.on('comando_silenciar', (idUsuarioMalportado) => {
    const elAudio = document.getElementById(`audio-${idUsuarioMalportado}`);
    if (elAudio) { elAudio.muted = true; }

    // Si es el propio socket → baneado local
    if (idUsuarioMalportado === socket.id) {
        baneadoLocal          = true;
        estaSilenciadoGlobal  = true;
        desactivarMicrofono();
        if (btnMute) btnMute.disabled = true;
    }
    actualizarInterfazUsuarios();
});

socket.on('notificacion_sistema', (msg) => {
    if (msg.includes("desactivado") || msg.includes("infracciones") || msg.includes("Advertencia")) {
        if (msg.includes("permanentemente")) {
            baneadoLocal         = true;
            estaSilenciadoGlobal = true;
            desactivarMicrofono();
            if (btnMute) btnMute.disabled = true;
        }
    }
    console.warn("Sistema:", msg);
});

// ─── LLAMADAS (PEERJS) ────────────────────────────────────────────────────────
function listenToCall() {
    peer.on('call', (call) => {
        obtenerMedia().then((stream) => {
            call.answer(stream);
            call.on('stream', (remoteStream) => gestionarNuevoStream(remoteStream, call.peer));
        });
    });
}

if (llamada) {
    llamada.addEventListener('click', (e) => {
        e.preventDefault();
        if (!chatHabilitadoPorPartida) { alert("Espera a que inicie la partida para llamar."); return; }
        listaUsuarios.forEach(({ socketId }) => {
            if (socket.id !== socketId) makeCall(socketId);
        });
    });
}

window.makeCall = function (receiverID) {
    obtenerMedia().then((stream) => {
        let call = peer.call(receiverID, stream);
        call.on('stream', (remoteStream) => gestionarNuevoStream(remoteStream, call.peer));
    });
};

function gestionarNuevoStream(stream, peerID) {
    if (!peerList.includes(peerID)) {
        peerList.push(peerID);
        addRemoteAudio(stream, peerID);
        actualizarInterfazUsuarios();
    }
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function addLocalAudio(stream) {
    if (document.getElementById('local-audio')) return;
    const audio = document.createElement('audio');
    audio.id       = 'local-audio';
    audio.srcObject = stream;
    audio.muted    = true;
    audio.autoplay = true;
    document.body.appendChild(audio);
}

function addRemoteAudio(stream, peerID) {
    let audio = document.getElementById(`audio-${peerID}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id       = `audio-${peerID}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
    }
    audio.srcObject = stream;
}

function actualizarInterfazUsuarios() {
    if (!userUiList) return;
    userUiList.innerHTML = '';

    peerList.forEach(peerID => {
        // Buscar info del usuario por socketId
        const info = listaUsuarios.find(u => u.socketId === peerID);
        const displayName = info?.username || `User-${peerID.substring(0, 5)}`;

        const li = document.createElement('li');
        Object.assign(li.style, {
            padding: '10px', borderBottom: '1px solid #444',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
        });

        const nombre = document.createElement('span');
        nombre.innerText = displayName;

        const containerButtons = document.createElement('div');

        // Mute individual
        const btnMuteInd = document.createElement('button');
        const elAudio = document.getElementById(`audio-${peerID}`);
        const isMuted = elAudio ? elAudio.muted : false;
        btnMuteInd.innerText              = isMuted ? "Escuchar" : "Silenciar";
        btnMuteInd.style.backgroundColor  = isMuted ? "#ff9800" : "#607d8b";
        btnMuteInd.style.color            = "white";
        btnMuteInd.style.border           = "none";
        btnMuteInd.style.padding          = "4px 8px";
        btnMuteInd.style.borderRadius     = "4px";
        btnMuteInd.style.cursor           = "pointer";
        btnMuteInd.onclick = () => {
            if (elAudio) {
                elAudio.muted    = !elAudio.muted;
                btnMuteInd.innerText = elAudio.muted ? "Escuchar" : "Silenciar";
                btnMuteInd.style.backgroundColor = elAudio.muted ? "#ff9800" : "#607d8b";
            }
        };

        // Reportar
        const btnReportar = document.createElement('button');
        btnReportar.innerText             = "Reportar";
        btnReportar.style.backgroundColor = "#d32f2f";
        btnReportar.style.color           = "white";
        btnReportar.style.marginLeft      = "8px";
        btnReportar.style.border          = "none";
        btnReportar.style.padding         = "4px 8px";
        btnReportar.style.borderRadius    = "4px";
        btnReportar.style.cursor          = "pointer";
        btnReportar.onclick = () => {
            const motivo = prompt(`Motivo del reporte para ${displayName}:`);
            if (motivo?.trim()) {
                socket.emit('enviar_reporte', { targetId: info?.userId || peerID, motivo });
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