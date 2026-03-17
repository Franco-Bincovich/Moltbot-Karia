require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleChat } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'El mensaje es requerido.' });
  }

  try {
    const reply = await handleChat(message, history || []);
    res.json({ reply });
  } catch (err) {
    console.error('Error en /api/chat:', err.message);
    res.status(500).json({ error: 'Error interno del agente.' });
  }
});

app.listen(PORT, () => {
  console.log(`Moltbot KarIA corriendo en http://localhost:${PORT}`);
});
