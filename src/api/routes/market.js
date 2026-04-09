'use strict';
// ============================================================
// routes/market.js — v2.2
// Variation = dernier impact de match (price_impact_log)
// ============================================================
const express = require('express');
const { getAllPrices, supabase, getLeaderboard } = require('../../services/supabaseService');
const router = express.Router();

router.get('/teams', async (req, res) => {
  try {
    const [teamsRes, supplyRes, statsRes] = await Promise.all([
      supabase.from('teams').select('*'),
      supabase.from('team_supply').select('*'),
      supabase.from('nhl_team_stats').select('*'),
    ]);
    const prices = await getAllPrices();

    // Dernier impact de MATCH par équipe (trigger = game_result uniquement)
    // C'est la variation d'UN seul match — ce que le joueur veut voir
    const { data: lastImpacts } = await supabase
      .from('price_impact_log')
      .select('team_id, pct_change, old_price, new_price, created_at')
      .eq('trigger', 'game_result')
      .order('created_at', { ascending: false })
      .limit(500); // assez pour couvrir les 32 équipes avec marge

    // Garder seulement le dernier impact par équipe
    const impactMap = {};
    for (const row of (lastImpacts || [])) {
      if (!impactMap[row.team_id]) {
        impactMap[row.team_id] = {
          pctChange:   parseFloat(row.pct_change || 0),
          oldPrice:    parseFloat(row.old_price || 0),
          newPrice:    parseFloat(row.new_price || 0),
          createdAt:   row.created_at,
        };
      }
    }

    const priceMap  = Object.fromEntries(prices.map(p => [p.team_id, p]));
    const supplyMap = Object.fromEntries((supplyRes.data || []).map(s => [s.team_id, s.available]));
    const statsMap  = Object.fromEntries((statsRes.data || []).map(s => [s.team_id, s]));
    const TOTAL_SHARES = 120_000_000;

    const result = (teamsRes.data || []).map(t => {
      const currentPrice = parseFloat(priceMap[t.id]?.price || 25);
      const impact       = impactMap[t.id];

      // Variation = dernier impact de match (pct et $ calculés depuis cet impact)
      const changePct    = impact ? impact.pctChange : 0;
      const changeDollar = impact ? parseFloat((impact.newPrice - impact.oldPrice).toFixed(2)) : 0;
      const hasChange    = impact !== undefined && changePct !== 0;

      const marketCap = currentPrice * TOTAL_SHARES;

      return {
        ...t,
        price:        currentPrice,
        prevPrice:    impact?.oldPrice || currentPrice,
        changePct:    Math.round(changePct * 100) / 100,
        changeDollar: Math.round(changeDollar * 100) / 100,
        hasChange,
        lastMatchAt:  impact?.createdAt || null,
        volume24h:    priceMap[t.id]?.volume_24h || 0,
        available:    supplyMap[t.id] ?? TOTAL_SHARES,
        marketCap,
        marketCapB:   Math.round(marketCap / 1_000_000) / 1000,
        stats:        statsMap[t.id] || {},
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prix historique
router.get('/team/:id/history', async (req, res) => {
  try {
    const { data } = await supabase
      .from('team_prices')
      .select('price, volume_24h, recorded_at')
      .eq('team_id', req.params.id.toUpperCase())
      .order('recorded_at', { ascending: false })
      .limit(30);
    res.json(data.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Carnet d'ordres
router.get('/orderbook/:id', async (req, res) => {
  try {
    const teamId = req.params.id.toUpperCase();
    const { data: orders } = await supabase
      .from('orders').select('side, price, qty, qty_filled')
      .eq('team_id', teamId).eq('status', 'open').order('price');
    const bids = orders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price).slice(0, 10);
    const asks = orders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price).slice(0, 10);
    res.json({ bids, asks });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Classement
router.get('/leaderboard', async (req, res) => {
  try {
    const data = await getLeaderboard(20);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
