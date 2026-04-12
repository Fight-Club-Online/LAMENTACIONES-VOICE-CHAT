export const socket = io();

const form     = document.getElementById('form');
const input    = document.getElementById('input');
const messages = document.getElementById('messages');

socket.on('connect', () => {
    const user = getLocalUser();
    
    // Extracción más robusta: busca el segmento después de /fight/
    const pathParts = location.pathname.split('/');
    const fightIndex = pathParts.indexOf('fight');
    const fightId = fightIndex !== -1 ? pathParts[fightIndex + 1] : null;

    if (user && fightId) {
        console.log(`[SOCKET] Reconectado. Uniéndose a pelea: ${fightId}`);
        socket.emit('join_fight', {
            fightId: fightId,
            userId: user.userId,
            username: user.username
        });
    }
});
const palabrasProhibidas = ["tonto", "feo", "spam", "maldito", "idiota"];

// ─── DATOS DEL USUARIO LOCAL ──────────────────────────────────────────────────
function getLocalUser() {
    try {
        const raw = localStorage.getItem('user_data');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

// ─── FILTRO LOCAL (feedback inmediato) ────────────────────────────────────────
function filtrarMensaje(texto) {
    let resultado = texto;
    palabrasProhibidas.forEach(palabra => {
        const regex = new RegExp(`\\b${palabra}\\b`, 'gi');
        resultado = resultado.replace(regex, "****");
    });
    return resultado;
}

// ─── RENDERIZAR UN MENSAJE ────────────────────────────────────────────────────
function renderMensaje(msg) {
    if (!msg) return;

    const localUser  = getLocalUser();
    const esMio      = msg.id === socket.id || msg.userId === localUser?.userId;

    // Nombre a mostrar: preferir username, luego userId corto, luego socketId corto
    const remitente = esMio
        ? "Tú"
        : (msg.username || (msg.userId ? msg.userId.substring(0, 8) : null) || `User-${(msg.id || '?').substring(0, 5)}`);

    const item = document.createElement('li');
    Object.assign(item.style, {
        padding:         '10px 15px',
        marginBottom:    '8px',
        borderRadius:    '12px',
        listStyle:       'none',
        maxWidth:        '75%',
        wordWrap:        'break-word',
        fontFamily:      'sans-serif'
    });

    if (esMio) {
        item.style.backgroundColor = '#e3f2fd';
        item.style.marginLeft      = 'auto';
        item.style.border          = '1px solid #bbdefb';
    } else {
        item.style.backgroundColor = '#ffffff';
        item.style.marginRight     = 'auto';
        item.style.border          = '1px solid #eeeeee';
        item.style.boxShadow       = '0 2px 4px rgba(0,0,0,0.05)';
    }

    // Timestamp si viene del historial
    const tsHtml = msg.timestamp
        ? `<span style="font-size:0.7rem;color:#999;margin-left:6px">${new Date(msg.timestamp).toLocaleTimeString()}</span>`
        : '';

    item.innerHTML = `
        <strong style="color:#1976d2;display:block;font-size:0.8rem;margin-bottom:4px;">
            ${remitente}${tsHtml}
        </strong>
        ${msg.texto || msg.text || ''}`;

    messages.appendChild(item);
    scrollAlFinal();
}

// ─── CARGAR HISTORIAL AL CONECTAR ─────────────────────────────────────────────
socket.on('estado_chat', async ({ activo, fightId }) => {
    if (!activo || !fightId) return;

    try {
        const res  = await fetch(`/api/mensajes/${fightId}`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return;

        // Separador visual
        const sep = document.createElement('li');
        sep.style.cssText = 'list-style:none;text-align:center;margin:12px 0;color:#aaa;font-size:0.75rem;';
        sep.innerText = '── Historial de la partida ──';
        messages.appendChild(sep);

        data.forEach(m => renderMensaje({
            id:        null,           // no es el socket actual
            userId:    m.userId,
            username:  m.username,
            texto:     m.texto,
            timestamp: m.timestamp
        }));

        const sep2 = document.createElement('li');
        sep2.style.cssText = 'list-style:none;text-align:center;margin:12px 0;color:#aaa;font-size:0.75rem;';
        sep2.innerText = '── Ahora en vivo ──';
        messages.appendChild(sep2);

    } catch (e) {
        console.warn('[HISTORIAL] No se pudo cargar:', e.message);
    }
});

// ─── ENVÍO DE MENSAJES ────────────────────────────────────────────────────────
form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;

    const localUser = getLocalUser();
    socket.emit('chat message', {
        id:       socket.id,
        userId:   localUser?.userId   || socket.id,
        username: localUser?.username || null,
        texto:    input.value
    });

    input.value = '';
});

// ─── RECIBIR MENSAJES ─────────────────────────────────────────────────────────
socket.on('chat message', renderMensaje);

// ─── NOTIFICACIONES DE SISTEMA ────────────────────────────────────────────────
socket.on('notificacion_sistema', (data) => {
    const item = document.createElement('li');
    item.style.cssText = 'text-align:center;margin:15px 0;list-style:none;';
    item.innerHTML = `
        <span style="background-color:#ffebee;color:#c62828;padding:5px 15px;border-radius:20px;font-size:0.85rem;border:1px solid #ffcdd2;font-style:italic;">
            ⚠️ <strong>Sistema:</strong> ${data}
        </span>`;
    messages.appendChild(item);
    scrollAlFinal();
});

// ─── SCROLL ───────────────────────────────────────────────────────────────────
function scrollAlFinal() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}