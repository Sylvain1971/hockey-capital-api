'use strict';
// ============================================================
// routes/market.js
// ============================================================
const express = require('express');
const { getAllPrices, supabase, getLeaderboard } = require('../../services/supabaseService');
const router = express.Router();

// Toutes les équipes + prix courants
router.get('/teams', async (req, res) => {
  try {
    const { data: teams } = await supabase.from('teams').select('*');
    const { data: supply } = await supabase.from('team_supply').select('*');
    const { data: stats }  = await supabase.from('nhl_team_stats').select('*');
    const prices = await getAllPrices();

    const priceMap  = Object.fromEntries(prices.map(p => [p.team_id, p]));
    const supplyMap = Object.fromEntries(supply.map(s => [s.team_id, s.available]));
    const statsMap  = Object.fromEntries(stats.map(s => [s.team_id, s]));

    const result = teams.map(t => ({
      ...t,
      price:     parseFloat(priceMap[t.id]?.price || 5),
      volume24h: priceMap[t.id]?.volume_24h || 0,
      available: supplyMap[t.id] ?? 100,
      stats:     statsMap[t.id] || {},
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prix historique d'une équipe (30 derniers points)
router.get('/team/:id/history', async (req, res) => {
  try {
    const { data } = await supabase
      .from('team_prices')
      .select('price, volume_24h, recorded_at')
      .eq('team_id', req.params.id.toUpperCase())
      .order('recorded_at', { ascending: false })
      .limit(30);
    res.json(data.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Carnet d'ordres
router.get('/orderbook/:id', async (req, res) => {
  try {
    const teamId = req.params.id.toUpperCase();
    const { data: orders } = await supabase
      .from('orders')
      .select('side, price, qty, qty_filled')
      .eq('team_id', teamId)
      .eq('status', 'open')
      .order('price');

    const bids = orders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price).slice(0, 10);
    const asks = orders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price).slice(0, 10);
    res.json({ bids, asks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Journal d'impact
router.get('/impact-log', async (req, res) => {
  try {
    const { data } = await supabase
      .from('price_impact_log')
      .select('*, teams(name, color)')
      .order('created_at', { ascending: false })
      .limit(50);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Classement investisseurs
router.get('/leaderboard', async (req, res) => {
  try {
    const data = await getLeaderboard(20);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
