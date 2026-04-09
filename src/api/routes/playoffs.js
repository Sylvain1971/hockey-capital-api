'use strict';
/**
 * playoffs.js — Routes séries éliminatoires
 * GET  /api/market/season-config   — config globale (mode, ronde)
 * POST /api/playoffs/distress-sell — vente de détresse équipe figée
 */

const express = require('express');
const router  = express.Router();
const { supabase } = require('../../services/supabaseService');
const { verifyToken } = require('../middleware/auth');

// GET /api/market/season-config
router.get('/market/season-config', async (req, res) => {
  try {
    const { data, error } = await supabase.from('season_config').select('*').eq('id', 1).single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/playoffs/distress-sell
router.post('/playoffs/distress-sell', verifyToken, async (req, res) => {
  const { leagueId, teamId, qty } = req.body;
  const userId = req.user.id;
  if (!leagueId || !teamId || !qty || qty <= 0) return res.status(400).json({ error: 'Parametres invalides' });

  try {
    const { data: team } = await supabase.from('teams')
      .select('playoff_locked, playoff_status, eliminated_at, season_close_price, price')
      .eq('id', teamId).single();
    if (!team?.playoff_locked) return res.status(400).json({ error: 'Cette equipe n est pas figee' });
    if (team.playoff_status === 'champion') return res.status(400).json({ error: 'Le champion ne peut pas etre vendu en detresse' });

    const { data: holding } = await supabase.from('league_holdings')
      .select('shares').eq('league_id', leagueId).eq('team_id', teamId).eq('user_id', userId).single();
    if (!holding || holding.shares < qty) return res.status(400).json({ error: 'Pas assez d actions' });

    const elimAt   = team.eliminated_at ? new Date(team.eliminated_at) : new Date();
    const jours    = Math.max(0, (Date.now() - elimAt.getTime()) / 86400000);
    const penalite = Math.min(0.15 + Math.pow(jours, 2) * 0.025, 0.50);
    const SPREAD   = 0.01;
    const prixFige = parseFloat(team.season_close_price || team.price || 0);
    const gross    = prixFige * qty;
    const cashRecu  = parseFloat((gross * (1 - penalite) * (1 - SPREAD)).toFixed(2));
    const cashBrule = parseFloat((gross * penalite).toFixed(2));

    const newShares = holding.shares - qty;
    if (newShares === 0) {
      await supabase.from('league_holdings').delete()
        .eq('league_id', leagueId).eq('team_id', teamId).eq('user_id', userId);
    } else {
      await supabase.from('league_holdings').update({ shares: newShares })
        .eq('league_id', leagueId).eq('team_id', teamId).eq('user_id', userId);
    }

    const { data: member } = await supabase.from('league_members')
      .select('cash').eq('league_id', leagueId).eq('user_id', userId).single();
    await supabase.from('league_members')
      .update({ cash: parseFloat(member.cash) + cashRecu })
      .eq('league_id', leagueId).eq('user_id', userId);

    await supabase.from('league_trades').insert({
      league_id: leagueId, user_id: userId, team_id: teamId,
      type: 'distress_sell', qty, price: prixFige,
      total: cashRecu,
      penalty_pct: parseFloat((penalite * 100).toFixed(2)),
      cash_burned: cashBrule,
    });

    res.json({ success: true, cashRecu, cashBrule, penalitePct: parseFloat((penalite * 100).toFixed(2)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
