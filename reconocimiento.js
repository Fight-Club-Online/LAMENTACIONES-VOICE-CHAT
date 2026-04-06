// reconocimiento.js
import { socket } from './chat.js'

let reconocimiento;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const btnHablar = document.getElementById('btn-hablar'); 
let texto = '';
let teclaPresionada = false; 

if (SpeechRecognition) {
    console.log("Sistema de reconocimiento listo");
    reconocimiento = new SpeechRecognition();
    reconocimiento.lang = 'es-ES';
    reconocimiento.continuous = true;
    reconocimiento.interimResults = true;

    reconocimiento.onresult = (event) => {
        let textoTemporal = ''; 
        for (let i = event.resultIndex; i < event.results.length; i++) {
            textoTemporal += event.results[i][0].transcript;
        }
        
        texto = textoTemporal; 
        console.log("Procesando voz:", texto);

        if (texto.length >= 150) {
            socket.emit('chat message', {
                id: socket.id,
                texto: texto   
            });
            texto = '';
        }
    }

    reconocimiento.onerror = (event) => {
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
            console.error('Error de reconocimiento:', event.error);
        }
    };

    reconocimiento.onend = () => {
        console.log("Reconocimiento finalizado");
    };

    const iniciarCaptura = () => {
        texto = ''; 
        try {
            reconocimiento.start();
        } catch (e) {
        }
    };

    const finalizarYEnviar = () => {
        if (texto.trim().length > 0) {
            socket.emit('chat message', {
                id: socket.id,
                texto: texto 
            });
        }
        reconocimiento.stop();
        texto = '';
    };

    if (btnHablar) {
        btnHablar.addEventListener('mousedown', iniciarCaptura);
        btnHablar.addEventListener('mouseup', finalizarYEnviar);
        
        btnHablar.addEventListener('touchstart', (e) => { 
            e.preventDefault(); 
            iniciarCaptura(); 
        });
        btnHablar.addEventListener('touchend', (e) => { 
            e.preventDefault(); 
            finalizarYEnviar(); 
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === " " && !teclaPresionada && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
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
    console.log("Navegador no soporta Web Speech API");
}