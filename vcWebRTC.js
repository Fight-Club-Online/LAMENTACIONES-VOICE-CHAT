import { socket } from './chat.js';

var peer = null;
var peerList = [];
let localStream = null;
let estaSilenciadoGlobal = false;
let baneadoLocal = false;
let chatHabilitadoPorPartida = false;

const llamada    = document.getElementById("llamada");
const btnHablar  = document.getElementById('btn-hablar');
const btnMute    = document.getElementById('btn-mute');
const userUiList = document.getElementById('user-ui-list');

let listaUsuarios = [];
const TECLA_PTT = " ";
let teclaPresionada = false;

// ─── BANNER ADVERTENCIA ───────────────────────────────────────────────────────
function mostrarBannerAdvertencia({ username, count, max, mensaje }) {
    let banner = document.getElementById('__adv-banner__');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = '__adv-banner__';
        Object.assign(banner.style, {
            position:'fixed', top:'70px', left:'50%', transform:'translateX(-50%)',
            zIndex:'9999', backgroundColor:'#7f1d1d', color:'#fecaca',
            border:'2px solid #ef4444', borderRadius:'12px', padding:'14px 24px',
            fontFamily:'sans-serif', fontSize:'14px', fontWeight:'bold',
            maxWidth:'480px', textAlign:'center', boxShadow:'0 4px 20px rgba(239,68,68,0.4)',
            transition:'opacity 0.4s'
        });
        document.body.appendChild(banner);
    }
    banner.innerText = mensaje || `⚠️ ${username} – Advertencia ${count}/${max}`;
    banner.style.opacity = '1'; banner.style.display = 'block';
    clearTimeout(banner.__timer);
    banner.__timer = setTimeout(() => {
        banner.style.opacity = '0';
        setTimeout(() => { banner.style.display = 'none'; }, 400);
    }, 5000);
}

// ─── LEER USUARIO LOCAL ───────────────────────────────────────────────────────
function getLocalUser() {
    try { return JSON.parse(localStorage.getItem('user_data') || 'null'); }
    catch { return null; }
}

// ─── INIT PEER ────────────────────────────────────────────────────────────────
function initPeer(userid) {
    if (peer) { try { peer.destroy(); } catch (_) {} }
    peer = new Peer(userid);
    peer.on('open', id => {
        console.log('[PEER] Abierto con ID:', id);
        listenToCall();
    });
    peer.on('error', err => console.error('[PEER] Error:', err));
}

// ─── AL CONECTAR ──────────────────────────────────────────────────────────────
socket.on('connect', () => {
    const user = getLocalUser();
    if (user?.userId) {
        // Obtener fightId de la URL
        const fightId = location.pathname.split('/fight/')[1]?.split('/')[0];
        socket.emit('join_fight', {
            fightId:  fightId || null,
            userId:   user.userId,
            username: user.username || user.userId
        });
    }
    initPeer(socket.id);
});

// ─── ESTADO DE PARTIDA ────────────────────────────────────────────────────────
socket.on('estado_chat', (estado) => {
    chatHabilitadoPorPartida = estado.activo;
    actualizarBotonHablar();
    if (chatHabilitadoPorPartida) {
        // Auto-llamar a todos al activarse la partida
        setTimeout(() => llamarATodos(), 500);
    } else {
        desactivarMicrofono();
    }
});

// ─── LISTA DE SOCKETS ─────────────────────────────────────────────────────────
socket.on('listaSockets', (lista) => {
    const prevCount = listaUsuarios.length;
    listaUsuarios = lista;
    // Si llega alguien nuevo y la partida está activa, llamarle
    if (chatHabilitadoPorPartida && lista.length > prevCount) {
        lista.forEach(({ socketId }) => {
            if (socketId !== socket.id && !peerList.includes(socketId)) {
                makeCall(socketId);
            }
        });
    }
    actualizarInterfazUsuarios();
});

// ─── LLAMAR A TODOS ───────────────────────────────────────────────────────────
function llamarATodos() {
    listaUsuarios.forEach(({ socketId }) => {
        if (socketId !== socket.id && !peerList.includes(socketId)) {
            makeCall(socketId);
        }
    });
}

// ─── OBTENER MEDIA ────────────────────────────────────────────────────────────
function obtenerMedia() {
    return new Promise((resolve, reject) => {
        if (localStream) { resolve(localStream); return; }
        navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        }).then(stream => {
            stream.getAudioTracks()[0].enabled = false; // empieza muteado (PTT)
            localStream = stream;
            addLocalAudio(stream);
            resolve(stream);
        }).catch(reject);
    });
}

// ─── MICROFONO PTT ────────────────────────────────────────────────────────────
function activarMicrofono() {
    if (baneadoLocal || !chatHabilitadoPorPartida) return;
    obtenerMedia().then(stream => {
        stream.getAudioTracks()[0].enabled = !estaSilenciadoGlobal;
        actualizarBotonHablar(true);
    });
}

function desactivarMicrofono() {
    if (localStream) localStream.getAudioTracks()[0].enabled = false;
    actualizarBotonHablar(false);
}

function actualizarBotonHablar(hablando = false) {
    if (!btnHablar) return;
    if (baneadoLocal) {
        btnHablar.disabled = true; btnHablar.innerText = '¡BLOQUEADO!';
        btnHablar.style.backgroundColor = '#b0bec5'; btnHablar.style.opacity = '1';
    } else if (!chatHabilitadoPorPartida) {
        btnHablar.disabled = true; btnHablar.innerText = 'Esperando partida...';
        btnHablar.style.backgroundColor = ''; btnHablar.style.opacity = '0.5';
    } else if (hablando) {
        btnHablar.disabled = false; btnHablar.innerText = 'Hablando...';
        btnHablar.style.backgroundColor = '#ff5722'; btnHablar.style.opacity = '1';
    } else {
        btnHablar.disabled = false; btnHablar.innerText = 'Pulsar para Hablar';
        btnHablar.style.backgroundColor = ''; btnHablar.style.opacity = '1';
    }
}

// ─── EVENTOS ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.key === TECLA_PTT && !teclaPresionada &&
        e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        teclaPresionada = true; activarMicrofono();
    }
});
document.addEventListener('keyup', e => {
    if (e.key === TECLA_PTT) { teclaPresionada = false; desactivarMicrofono(); }
});

if (btnHablar) {
    btnHablar.addEventListener('mousedown', activarMicrofono);
    btnHablar.addEventListener('mouseup', desactivarMicrofono);
    btnHablar.addEventListener('touchstart', e => { e.preventDefault(); activarMicrofono(); });
    btnHablar.addEventListener('touchend', e => { e.preventDefault(); desactivarMicrofono(); });
}

if (llamada) {
    llamada.addEventListener('click', e => {
        e.preventDefault();
        if (!chatHabilitadoPorPartida) { alert("Espera a que inicie la partida."); return; }
        llamarATodos();
    });
}

if (btnMute) {
    btnMute.addEventListener('click', () => {
        if (baneadoLocal) return;
        estaSilenciadoGlobal = !estaSilenciadoGlobal;
        if (localStream) localStream.getAudioTracks()[0].enabled = !estaSilenciadoGlobal;
        btnMute.innerText = estaSilenciadoGlobal ? 'Activar Micro' : 'Silenciar Micro';
        btnMute.style.backgroundColor = estaSilenciadoGlobal ? '#f44336' : '#607d8b';
        socket.emit('toggle_mute_local', { mutedSelf: estaSilenciadoGlobal });
    });
}

// ─── MODERACIÓN ───────────────────────────────────────────────────────────────
socket.on('advertencia_sistema', data => {
    mostrarBannerAdvertencia(data);
    const messages = document.getElementById('messages');
    if (messages) {
        const item = document.createElement('li');
        item.style.cssText = 'text-align:center;margin:10px 0;list-style:none;';
        item.innerHTML = `<span style="background:#7f1d1d;color:#fecaca;padding:5px 15px;
            border-radius:20px;font-size:0.82rem;border:1px solid #ef4444;">
            ⚠️ <strong>Advertencia:</strong> ${data.mensaje}</span>`;
        messages.appendChild(item);
    }
});

socket.on('peer_mute_changed', ({ socketId, muted }) => {
    const el = document.getElementById(`audio-${socketId}`);
    if (el) el.muted = muted;
});

socket.on('comando_silenciar', id => {
    const el = document.getElementById(`audio-${id}`);
    if (el) el.muted = true;
    if (id === socket.id) {
        baneadoLocal = true; estaSilenciadoGlobal = true;
        desactivarMicrofono();
        if (btnMute) btnMute.disabled = true;
    }
});

socket.on('notificacion_sistema', msg => console.warn('Sistema:', msg));

// ─── PEERJS ───────────────────────────────────────────────────────────────────
function listenToCall() {
    peer.on('call', call => {
        obtenerMedia().then(stream => {
            call.answer(stream);
            call.on('stream', remote => gestionarStream(remote, call.peer));
            call.on('error', err => console.error('[PEER] Call error:', err));
        });
    });
}

window.makeCall = function(receiverID) {
    obtenerMedia().then(stream => {
        const call = peer.call(receiverID, stream);
        if (!call) return;
        call.on('stream', remote => gestionarStream(remote, call.peer));
        call.on('error', err => console.error('[PEER] makeCall error:', err));
    }).catch(err => console.error('[MEDIA] Error:', err));
};

function gestionarStream(stream, peerID) {
    if (!peerList.includes(peerID)) {
        peerList.push(peerID);
        addRemoteAudio(stream, peerID);
        actualizarInterfazUsuarios();
    }
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function addLocalAudio(stream) {
    if (document.getElementById('local-audio')) return;
    const a = Object.assign(document.createElement('audio'), {
        id: 'local-audio', muted: true, autoplay: true
    });
    a.srcObject = stream;
    document.body.appendChild(a);
}

function addRemoteAudio(stream, peerID) {
    let a = document.getElementById(`audio-${peerID}`);
    if (!a) {
        a = Object.assign(document.createElement('audio'), { id: `audio-${peerID}`, autoplay: true });
        document.body.appendChild(a);
    }
    a.srcObject = stream;
}

function actualizarInterfazUsuarios() {
    if (!userUiList) return;
    userUiList.innerHTML = '';
    peerList.forEach(peerID => {
        const info = listaUsuarios.find(u => u.socketId === peerID);
        const displayName = info?.username || `User-${peerID.substring(0, 5)}`;
        const li = document.createElement('li');
        li.style.cssText = 'padding:10px;border-bottom:1px solid #444;display:flex;align-items:center;justify-content:space-between;list-style:none;';
        
        const nombre = document.createElement('span');
        nombre.innerText = displayName;

        const elAudio = document.getElementById(`audio-${peerID}`);
        const btnMuteInd = document.createElement('button');
        btnMuteInd.innerText = elAudio?.muted ? 'Escuchar' : 'Silenciar';
        Object.assign(btnMuteInd.style, {
            backgroundColor: elAudio?.muted ? '#ff9800' : '#607d8b',
            color: 'white', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer'
        });
        btnMuteInd.onclick = () => {
            if (!elAudio) return;
            elAudio.muted = !elAudio.muted;
            btnMuteInd.innerText = elAudio.muted ? 'Escuchar' : 'Silenciar';
            btnMuteInd.style.backgroundColor = elAudio.muted ? '#ff9800' : '#607d8b';
        };

        const btnRep = document.createElement('button');
        btnRep.innerText = 'Reportar';
        Object.assign(btnRep.style, {
            backgroundColor: '#d32f2f', color: 'white', marginLeft: '8px',
            border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer'
        });
        btnRep.onclick = () => {
            const motivo = prompt(`Motivo del reporte para ${displayName}:`);
            if (motivo?.trim()) {
                socket.emit('enviar_reporte', { targetId: info?.userId || peerID, motivo });
                alert('Reporte enviado.');
            }
        };

        const btns = document.createElement('div');
        btns.appendChild(btnMuteInd); btns.appendChild(btnRep);
        li.appendChild(nombre); li.appendChild(btns);
        userUiList.appendChild(li);
    });
}