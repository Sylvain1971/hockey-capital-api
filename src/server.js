'use strict';
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { WebSocketServer } = require('ws');
const http    = require('http');
const { runJob, loadSeasonConfig } = require('./services/nhlJob');

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
app.use('/api',           require('./api/routes/playoffs')); // season-config + distress-sell

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.1.0-PLAYOFFS' }));

// ---- SERVEUR HTTP + WEBSOCKET ----
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Hockey Capital WebSocket connecté' }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---- JOBS PLANIFIÉS ----
// runJob lit season_config et dispatche automatiquement (regular ou playoffs)
setInterval(() => runJob(broadcast), 30_000);
setTimeout(async () => {
  await loadSeasonConfig();
  runJob(broadcast);
}, 2000);

// ---- DÉMARRAGE ----
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hockey Capital API démarrée sur le port ${PORT}`);
  console.log('Version: 1.1.0-PLAYOFFS');
  console.log('Environnement: ' + (process.env.NODE_ENV || 'development'));
});

module.exports = { app, broadcast };
