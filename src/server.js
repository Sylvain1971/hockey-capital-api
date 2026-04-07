'use strict';
/**
 * Hockey Capital — Serveur Express
 * WebSocket temps réel + routes REST
 */

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
app.use('/api/auth',     require('./api/routes/auth'));
app.use('/api/market',   require('./api/routes/market'));
app.use('/api/orders',   require('./api/routes/orders').ordersRouter);
app.use('/api/portfolio',require('./api/routes/portfolio'));
app.use('/api/leagues', require('./api/routes/leagues'));
app.use('/api/admin',    require('./api/routes/admin'));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0-VERSION-INITIALE' }));

// ---- SERVEUR HTTP + WEBSOCKET ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Hockey Capital WebSocket connecté' }));
  ws.on('close', () => clients.delete(ws));
});

/**
 * Broadcast à tous les clients WebSocket connectés
 */
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---- JOBS PLANIFIÉS ----

// Scores LNH toutes les 30 secondes
setInterval(() => processScores(broadcast), 30_000);

// Classements une fois par heure
setInterval(() => processStandings(broadcast), 60 * 60_000);

// Premier fetch immédiat au démarrage
setTimeout(() => {
  processScores(broadcast);
  processStandings(broadcast);
}, 2000);

// ---- DÉMARRAGE ----
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🏒 Hockey Capital API démarrée sur le port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Version algorithme: VERSION INITIALE`);
  console.log(`   Environnement: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = { app, broadcast };
