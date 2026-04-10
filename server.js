const express = require('express');
const cors = require('cors');
const app = express();

// Configuración de CORS
app.use(cors({
  origin: 'http://localhost:5173', // La URL de tu Frontend
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Tu ruta que recibe la llamada de Spring Boot
app.post('/api/iniciar-partida', (req, res) => {
    const { fightId, roomId, players } = req.body;
    console.log(`[REST] Partida iniciada. fightId=${fightId} | jugadores=${players.length}`);
    res.status(200).send("OK");
});

app.listen(300, () => {
    console.log('Voice Chat escuchando en el puerto 300');
});