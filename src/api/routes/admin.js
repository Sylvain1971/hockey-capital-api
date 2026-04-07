'use strict';
// ============================================================
// routes/admin.js — déclenchement manuel des jobs
// ============================================================
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { processScores, processStandings } = require('../../services/nhlJob');
const { supabase } = require('../../services/supabaseService');
const { applyPlayoffElimination } = require('../../services/priceImpact');
const { updatePrice, logPriceImpact, getCurrentPrice, payDividend } = require('../../services/supabaseService');
const router = express.Router();

// Forcer un fetch des scores LNH
router.post('/fetch-scores', requireAdmin, async (req, res) => {
  try {
    await processScores();
    res.json({ message: 'Scores LNH traités' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forcer un fetch des classements
router.post('/fetch-standings', requireAdmin, async (req, res) => {
  try {
    await processStandings();
    res.json({ message: 'Classements LNH traités' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Appliquer élimination playoffs manuellement
router.post('/eliminate/:teamId', requireAdmin, async (req, res) => {
  try {
    const teamId = req.params.teamId.toUpperCase();
    const currentPrice = await getCurrentPrice(teamId);
    const { applyPlayoffElimination } = require('../../services/priceImpact');
    const result = applyPlayoffElimination(currentPrice);
    await updatePrice(teamId, result.newPrice);
    await logPriceImpact(teamId, 'elimination', result.log.description, currentPrice, result.newPrice);
    res.json({ teamId, oldPrice: currentPrice, newPrice: result.newPrice, pctChange: result.pctChange });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verser un dividende manuellement (playoffs, événements spéciaux)
router.post('/dividend', requireAdmin, async (req, res) => {
  const { teamId, amountPerShare, reason } = req.body;
  try {
    const result = await payDividend({ teamId: teamId.toUpperCase(), amountPerShare, reason, streakAtTime: 0, multiplier: 1 });
    res.json({ message: 'Dividende versé', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Journal d'impact (admin: toutes les équipes, illimité)
router.get('/impact-log', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('price_impact_log').select('*').order('created_at', { ascending: false }).limit(200);
  res.json(data);
});

module.exports = router;
