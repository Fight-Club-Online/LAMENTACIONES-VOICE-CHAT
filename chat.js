// chat.js
export const socket = io();

const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');

const palabrasProhibidas = ["tonto", "feo", "spam", "maldito", "idiota"];

/**
 * Filtra el texto comparándolo con la lista de palabras prohibidas.
 */
function filtrarMensaje(texto) {
    let resultado = texto;
    palabrasProhibidas.forEach(palabra => {
        const regex = new RegExp(`\\b${palabra}\\b`, 'gi');
        resultado = resultado.replace(regex, "****");
    });
    return resultado;
}

// --- ENVÍO DE MENSAJES ---
form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    if (input.value.trim()) {
        const textoOriginal = input.value;
        
        socket.emit('chat message', {
            id: socket.id,
            texto: textoOriginal
        });
        
        input.value = '';
    }
});

socket.on('chat message', (msg) => {
    if (!msg || !msg.id) return;

    const item = document.createElement('li');
    const esMio = msg.id === socket.id;
    const remitente = esMio ? "Tú" : `Usuario (${msg.id.substring(0, 5)})`;
    
    item.style.padding = "10px 15px";
    item.style.marginBottom = "8px";
    item.style.borderRadius = "12px";
    item.style.listStyle = "none";
    item.style.maxWidth = "75%";
    item.style.wordWrap = "break-word";
    item.style.fontFamily = "sans-serif";

    if (esMio) {
        item.style.backgroundColor = "#e3f2fd"; 
        item.style.marginLeft = "auto";       
        item.style.border = "1px solid #bbdefb";
    } else {
        item.style.backgroundColor = "#ffffff"; 
        item.style.marginRight = "auto";      
        item.style.border = "1px solid #eeeeee";
        item.style.boxShadow = "0 2px 4px rgba(0,0,0,0.05)";
    }

    item.innerHTML = `<strong style="color: #1976d2; display: block; font-size: 0.8rem; margin-bottom: 4px;">${remitente}</strong> ${msg.texto}`;
    
    messages.appendChild(item);
    scrollAlFinal();
});

socket.on('notificacion_sistema', (data) => {
    const item = document.createElement('li');
    item.style.textAlign = "center";
    item.style.margin = "15px 0";
    item.style.listStyle = "none";
    
    item.innerHTML = `
        <span style="background-color: #ffebee; color: #c62828; padding: 5px 15px; border-radius: 20px; font-size: 0.85rem; border: 1px solid #ffcdd2; font-style: italic;">
            ⚠️ <strong>Sistema:</strong> ${data}
        </span>
    `;
    
    messages.appendChild(item);
    scrollAlFinal();
});

function scrollAlFinal() {
    window.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'smooth'
    });
}