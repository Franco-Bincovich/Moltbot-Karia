require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleChat } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

// Log de cada request entrante
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/chat', async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] /api/chat recibido`);
  console.log(`[${ts}] Body:`, JSON.stringify(req.body));

  const { message, history } = req.body;

  if (!message) {
    console.warn(`[${ts}] /api/chat: mensaje vacío, rechazando request`);
    return res.status(400).json({ error: 'El mensaje es requerido.' });
  }

  console.log(`[${ts}] Mensaje: "${message}" | Historial: ${(history || []).length} turnos`);

  try {
    console.log(`[${ts}] Llamando a handleChat...`);
    const reply = await handleChat(message, history || []);
    console.log(`[${new Date().toISOString()}] handleChat completado. Respuesta (primeros 200 chars): ${String(reply).slice(0, 200)}`);
    res.json({ reply });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en /api/chat:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del agente.' });
  }
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Moltbot KarIA corriendo en http://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] PERPLEXITY_API_KEY: ${process.env.PERPLEXITY_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
});
