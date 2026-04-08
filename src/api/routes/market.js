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

    // Prix de référence = premier enregistrement de la journée (prix d'ouverture)
    // Si pas d'entrée hier, on prend le plus ancien prix du jour comme référence
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    // Essayer d'abord le dernier prix d'avant aujourd'hui (prix de clôture d'hier)
    const { data: prevPricesHier } = await supabase
      .from('team_prices')
      .select('team_id, price, recorded_at')
      .lt('recorded_at', todayMidnight.toISOString())
      .order('recorded_at', { ascending: false })
      .limit(64);

    // Si pas de données d'hier, prendre le premier prix du jour (ouverture)
    const { data: firstPricesAujourdhui } = await supabase
      .from('team_prices')
      .select('team_id, price, recorded_at')
      .gte('recorded_at', todayMidnight.toISOString())
      .order('recorded_at', { ascending: true })
      .limit(64);

    // Construire map: priorité à hier, sinon premier prix du jour
    const prevMap = {};
    for (const p of prevPricesHier || []) {
      if (!prevMap[p.team_id]) prevMap[p.team_id] = parseFloat(p.price);
    }
    // Pour les équipes sans données hier, utiliser le premier prix du jour
    for (const p of firstPricesAujourdhui || []) {
      if (!prevMap[p.team_id]) prevMap[p.team_id] = parseFloat(p.price);
    }

    const priceMap  = Object.fromEntries(prices.map(p => [p.team_id, p]));
    const supplyMap = Object.fromEntries(supply.map(s => [s.team_id, s.available]));
    const statsMap  = Object.fromEntries(stats.map(s => [s.team_id, s]));

    const TOTAL_SHARES = 120_000_000;

    const result = teams.map(t => {
      const currentPrice = parseFloat(priceMap[t.id]?.price || 25);
      const prevPrice = prevMap[t.id] || currentPrice;
      const changePct = prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice * 100) : 0;
      const marketCap = currentPrice * TOTAL_SHARES;

      return {
        ...t,
        price:      currentPrice,
        prevPrice,
        changePct:  Math.round(changePct * 100) / 100,
        volume24h:  priceMap[t.id]?.volume_24h || 0,
        available:  supplyMap[t.id] ?? TOTAL_SHARES,
        marketCap,
        marketCapB: Math.round(marketCap / 1_000_000) / 1000, // en milliards, arrondi
        stats:      statsMap[t.id] || {},
      };
    });
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
