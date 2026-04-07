'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const { processScores, processStandings } = require('./services/nhlJob');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ---- ROUTES ----
app.use('/api/auth',      require('./api/routes/auth'));
app.use('/api/market',    require('./api/routes/market'));
app.use('/api/orders',    require('./api/routes/orders').ordersRouter);
app.use('/api/portfolio', require('./api/routes/portfolio'));
app.use('/api/leagues',   require('./api/routes/leagues'));
app.use('/api/admin',     require('./api/routes/admin'));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0-VERSION-INITIALE' }));

// ---- SERVEUR HTTP + WEBSOCKET ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Hockey Capital WebSocket connecte' }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---- JOBS PLANIFIES ----
setInterval(() => processScores(broadcast), 30_000);
setInterval(() => processStandings(broadcast), 60 * 60_000);
setTimeout(() => { processScores(broadcast); processStandings(broadcast); }, 2000);

// ---- DEMARRAGE ----
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Hockey Capital API demarree sur le port ' + PORT);
  console.log('Version algorithme: VERSION INITIALE');
  console.log('Environnement: ' + (process.env.NODE_ENV || 'development'));
});

module.exports = { app, broadcast };
