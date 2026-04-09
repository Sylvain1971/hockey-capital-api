'use strict';
// ============================================================
// routes/market.js — v2.1
// ============================================================
const express = require('express');
const { getAllPrices, supabase, getLeaderboard } = require('../../services/supabaseService');
const router = express.Router();

// Toutes les équipes + prix courants
router.get('/teams', async (req, res) => {
  try {
    const [teamsRes, supplyRes, statsRes] = await Promise.all([
      supabase.from('teams').select('*'),
      supabase.from('team_supply').select('*'),
      supabase.from('nhl_team_stats').select('*'),
    ]);
    const prices = await getAllPrices();

    // Prix de référence = DERNIER prix enregistré AVANT le premier match d'aujourd'hui
    // On prend le dernier prix de team_prices AVANT today, par équipe
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];

    // Chercher dans daily_open_prices le prix d'ouverture du JOUR PRÉCÉDENT (avant le 1er match du jour)
    // Si pas disponible hier, prendre avant-hier, etc. — on cherche sur 7 jours
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenStr = sevenDaysAgo.toISOString().split('T')[0];

    // Prix du DERNIER match joué la veille (prix de clôture de la dernière partie)
    // On utilise team_prices pour récupérer le prix juste avant today
    const { data: prevPricesRaw } = await supabase
      .from('team_prices')
      .select('team_id, price, recorded_at')
      .lt('recorded_at', today + 'T00:00:00Z')
      .gte('recorded_at', sevenStr + 'T00:00:00Z')
      .order('recorded_at', { ascending: false });

    // Garder seulement le dernier par équipe (le plus récent avant aujourd'hui)
    const prevMap = {};
    for (const row of (prevPricesRaw || [])) {
      if (!prevMap[row.team_id]) {
        prevMap[row.team_id] = parseFloat(row.price);
      }
    }

    const priceMap  = Object.fromEntries(prices.map(p => [p.team_id, p]));
    const supplyMap = Object.fromEntries((supplyRes.data || []).map(s => [s.team_id, s.available]));
    const statsMap  = Object.fromEntries((statsRes.data || []).map(s => [s.team_id, s]));
    const TOTAL_SHARES = 120_000_000;

    const result = (teamsRes.data || []).map(t => {
      const currentPrice = parseFloat(priceMap[t.id]?.price || 25);
      const prevPrice    = prevMap[t.id] || null; // null si pas de match récent
      const changePct    = prevPrice ? ((currentPrice - prevPrice) / prevPrice * 100) : 0;
      const changeDollar = prevPrice ? (currentPrice - prevPrice) : 0;
      const marketCap    = currentPrice * TOTAL_SHARES;

      return {
        ...t,
        price:       currentPrice,
        prevPrice:   prevPrice || currentPrice,
        changePct:   Math.round(changePct * 100) / 100,
        changeDollar: Math.round(changeDollar * 100) / 100,
        hasChange:   prevPrice !== null && prevPrice !== currentPrice,
        volume24h:   priceMap[t.id]?.volume_24h || 0,
        available:   supplyMap[t.id] ?? TOTAL_SHARES,
        marketCap,
        marketCapB:  Math.round(marketCap / 1_000_000) / 1000,
        stats:       statsMap[t.id] || {},
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
