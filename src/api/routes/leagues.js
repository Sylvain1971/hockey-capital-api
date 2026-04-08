'use strict';
/**
 * Hockey Capital — Routes ligues + AMM
 * Marché configuré par ligue, market maker automatique, prix à 5$/action
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { supabase } = require('../../services/supabaseService');
const { applyGameResult, applyStandingsAdjustment, applyPlayoffClinch } = require('../../services/priceImpact');
const router = express.Router();

const SHARES_PER_TEAM = 10000;
const AMM_RESERVE_PCT = 0.70;
const EMISSION_PRICE  = 5.00;

// ---- Créer une ligue ----
router.post('/', requireAuth, async (req, res) => {
  const {
    name, players, duration, draft, mise, capital,
    tradeLimit, maxConc, spread, delay,
    dividendsEnabled, limitOrdersEnabled, shortEnabled, elimPenalty,
    prizeMode, customPrize, bonusWeekly, bonusMid, bonusLast,
    algo,
  } = req.body;

  if (!name || !players || !mise || !capital) return res.status(400).json({ error: 'Paramètres manquants' });

  const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

  const { data: league, error } = await supabase.from('leagues').insert({
    name, creator_id: req.user.id, invite_code: inviteCode,
    max_players: players, duration, draft_mode: draft,
    mise_reelle: mise, capital_virtuel: capital,
    trade_limit_weekly: tradeLimit, max_conc_pct: maxConc,
    amm_spread_pct: spread, trade_delay: delay,
    dividends_enabled: dividendsEnabled !== false,
    limit_orders_enabled: limitOrdersEnabled !== false,
    short_selling: !!shortEnabled,
    elim_penalty: elimPenalty !== false,
    prize_mode: prizeMode, custom_prize: customPrize || [],
    bonus_weekly: !!bonusWeekly, bonus_mid: !!bonusMid, bonus_last: !!bonusLast,
    algo_config: algo || {},
    status: 'open',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Inscrire le créateur comme membre
  await supabase.from('league_members').insert({
    league_id: league.id, user_id: req.user.id, cash: capital, is_creator: true,
  });

  // Sauvegarder les invitations email
  const inviteEmails = req.body.inviteEmails || [];
  if (inviteEmails.length > 0) {
    const invites = inviteEmails.map(e => ({
      league_id: league.id,
      email: e.toLowerCase().trim(),
    }));
    await supabase.from('league_invitations').upsert(invites, { onConflict: 'league_id,email' });
  }

  // Initialiser les prix AMM pour cette ligue
  const { data: teams } = await supabase.from('teams').select('id');
  const priceInserts = teams.map(t => ({
    league_id: league.id, team_id: t.id,
    price: EMISSION_PRICE, amm_reserve: Math.floor(SHARES_PER_TEAM * AMM_RESERVE_PCT),
  }));
  await supabase.from('league_team_prices').insert(priceInserts);

  res.status(201).json({ league, inviteCode });
});

// ---- Rejoindre par code (body) ----
router.post('/join', requireAuth, async (req, res) => {
  const code = (req.body.inviteCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Code requis' });
  const { data: league } = await supabase.from('leagues')
    .select('*').eq('invite_code', code).single();
  if (!league) return res.status(404).json({ error: 'Code invalide' });
  if (league.status !== 'open') return res.status(400).json({ error: 'Ligue fermee ou terminee' });
  const { count } = await supabase.from('league_members').select('*', { count:'exact' }).eq('league_id', league.id);
  if (count >= league.max_players) return res.status(400).json({ error: 'Ligue complete' });
  const existing = await supabase.from('league_members').select('id').eq('league_id', league.id).eq('user_id', req.user.id).single();
  if (existing.data) return res.status(400).json({ error: 'Deja membre de cette ligue' });
  await supabase.from('league_members').insert({ league_id: league.id, user_id: req.user.id, cash: league.capital_virtuel });
  res.json({ league });
});

// ---- Rejoindre par code (URL param) ----
router.post('/join/:code', requireAuth, async (req, res) => {
  const { data: league } = await supabase.from('leagues')
    .select('*').eq('invite_code', req.params.code.toUpperCase()).single();
  if (!league) return res.status(404).json({ error: 'Code invalide' });
  if (league.status !== 'open') return res.status(400).json({ error: 'Ligue déjà commencée ou fermée' });

  const { count } = await supabase.from('league_members').select('*', { count:'exact' }).eq('league_id', league.id);
  if (count >= league.max_players) return res.status(400).json({ error: 'Ligue complète' });

  const existing = await supabase.from('league_members').select('id').eq('league_id', league.id).eq('user_id', req.user.id).single();
  if (existing.data) return res.status(400).json({ error: 'Déjà membre' });

  await supabase.from('league_members').insert({ league_id: league.id, user_id: req.user.id, cash: league.capital_virtuel });
  res.json({ league });
});

// ---- Mes ligues ----
router.get('/mine', requireAuth, async (req, res) => {
  // Ligues où l'utilisateur est membre
  const { data: member } = await supabase
    .from('league_members')
    .select('is_creator, leagues(*)')
    .eq('user_id', req.user.id);

  // Ligues créées par l'utilisateur (au cas où il ne serait pas dans league_members)
  const { data: created } = await supabase
    .from('leagues')
    .select('*')
    .eq('creator_id', req.user.id);

  // Fusionner sans doublons
  const memberLeagueIds = new Set((member || []).map(m => m.leagues?.id).filter(Boolean));
  const memberLeagues = (member || []).map(m => ({ ...m.leagues, is_creator: m.is_creator })).filter(l => l.id);
  const createdOnly = (created || []).filter(l => !memberLeagueIds.has(l.id)).map(l => ({ ...l, is_creator: true }));

  const all = [...memberLeagues, ...createdOnly].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(all);
});

// ---- Détails d'une ligue ----
router.get('/:id', async (req, res) => {
  const { data } = await supabase.from('leagues').select('*, league_members(count)').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Ligue introuvable' });
  res.json(data);
});

// ---- Prix du marché de la ligue ----
router.get('/:id/market/prices', async (req, res) => {
  const { data } = await supabase.from('league_team_prices')
    .select('*, teams(name, color, division)')
    .eq('league_id', req.params.id);
  res.json(data || []);
});

// ---- Carnet d'ordres AMM ----
router.get('/:id/market/orderbook/:teamId', async (req, res) => {
  const { data: lp } = await supabase.from('league_team_prices')
    .select('price, amm_spread_pct').eq('league_id', req.params.id).eq('team_id', req.params.teamId).single();

  const { data: league } = await supabase.from('leagues').select('amm_spread_pct').eq('id', req.params.id).single();
  const spread = (lp?.amm_spread_pct || league?.amm_spread_pct || 2) / 100;
  const p = lp?.price || EMISSION_PRICE;
  const ammAsk = parseFloat((p * (1 + spread / 2)).toFixed(4));
  const ammBid = parseFloat((p * (1 - spread / 2)).toFixed(4));

  // Ordres limités des joueurs
  const { data: playerOrders } = await supabase.from('league_orders')
    .select('side, price, qty, profiles(username)')
    .eq('league_id', req.params.id).eq('team_id', req.params.teamId).eq('status', 'open');

  const asks = (playerOrders || []).filter(o => o.side === 'sell').sort((a,b) => a.price - b.price);
  const bids = (playerOrders || []).filter(o => o.side === 'buy').sort((a,b) => b.price - a.price);

  res.json({
    ref: p, ammAsk, ammBid, spread: spread * 100,
    asks: [{ price: ammAsk, qty: Infinity, source: 'AMM' }, ...asks],
    bids: [{ price: ammBid, qty: Infinity, source: 'AMM' }, ...bids],
  });
});

// ---- Achat ----
router.post('/:id/market/buy', requireAuth, async (req, res) => {
  const { teamId, qty, orderType, limitPrice } = req.body;
  const leagueId = req.params.id;

  const { data: member } = await supabase.from('league_members').select('cash').eq('league_id', leagueId).eq('user_id', req.user.id).single();
  if (!member) return res.status(403).json({ error: 'Pas membre de cette ligue' });

  const { data: lp } = await supabase.from('league_team_prices').select('price, amm_reserve, amm_spread_pct').eq('league_id', leagueId).eq('team_id', teamId).single();
  const { data: league } = await supabase.from('leagues').select('amm_spread_pct, algo_config').eq('id', leagueId).single();

  const spread = ((lp?.amm_spread_pct || league?.amm_spread_pct || 2)) / 100;
  const refPrice = lp?.price || EMISSION_PRICE;
  const execPrice = orderType === 'limit' && limitPrice ? parseFloat(limitPrice) : parseFloat((refPrice * (1 + spread / 2)).toFixed(4));
  const cost = parseFloat((execPrice * qty).toFixed(4));

  if (cost > member.cash) return res.status(400).json({ error: 'Liquidités insuffisantes' });
  if (qty > (lp?.amm_reserve || SHARES_PER_TEAM * AMM_RESERVE_PCT)) return res.status(400).json({ error: 'Pas assez d\'actions disponibles' });

  if (orderType === 'limit') {
    await supabase.from('league_orders').insert({ league_id:leagueId, user_id:req.user.id, team_id:teamId, side:'buy', price:execPrice, qty, status:'open' });
    await supabase.from('league_members').update({ cash: member.cash - cost }).eq('league_id', leagueId).eq('user_id', req.user.id);
    return res.json({ type:'limit_placed', execPrice, qty, cost });
  }

  // Exécution marché immédiate via AMM
  await Promise.all([
    supabase.from('league_members').update({ cash: member.cash - cost }).eq('league_id', leagueId).eq('user_id', req.user.id),
    supabase.from('league_team_prices').update({ amm_reserve: (lp?.amm_reserve || 7000) - qty }).eq('league_id', leagueId).eq('team_id', teamId),
    supabase.from('league_holdings').upsert({ league_id:leagueId, user_id:req.user.id, team_id:teamId, shares: qty, avg_cost: execPrice }, { onConflict:'league_id,user_id,team_id', ignoreDuplicates:false }),
    supabase.from('league_trades').insert({ league_id:leagueId, buyer_id:req.user.id, team_id:teamId, price:execPrice, qty }),
  ]);

  res.json({ type:'market', execPrice, qty, cost });
});

// ---- Vente ----
router.post('/:id/market/sell', requireAuth, async (req, res) => {
  const { teamId, qty, orderType, limitPrice } = req.body;
  const leagueId = req.params.id;

  const { data: holding } = await supabase.from('league_holdings').select('shares').eq('league_id', leagueId).eq('user_id', req.user.id).eq('team_id', teamId).single();
  if (!holding || holding.shares < qty) return res.status(400).json({ error: 'Actions insuffisantes' });

  const { data: lp } = await supabase.from('league_team_prices').select('price, amm_spread_pct').eq('league_id', leagueId).eq('team_id', teamId).single();
  const { data: league } = await supabase.from('leagues').select('amm_spread_pct').eq('id', leagueId).single();
  const spread = ((lp?.amm_spread_pct || league?.amm_spread_pct || 2)) / 100;
  const refPrice = lp?.price || EMISSION_PRICE;
  const execPrice = orderType === 'limit' && limitPrice ? parseFloat(limitPrice) : parseFloat((refPrice * (1 - spread / 2)).toFixed(4));
  const proceeds = parseFloat((execPrice * qty).toFixed(4));

  const { data: member } = await supabase.from('league_members').select('cash').eq('league_id', leagueId).eq('user_id', req.user.id).single();

  await Promise.all([
    supabase.from('league_members').update({ cash: member.cash + proceeds }).eq('league_id', leagueId).eq('user_id', req.user.id),
    supabase.from('league_holdings').update({ shares: holding.shares - qty }).eq('league_id', leagueId).eq('user_id', req.user.id).eq('team_id', teamId),
    supabase.from('league_team_prices').update({ amm_reserve: supabase.raw(`amm_reserve + ${qty}`) }).eq('league_id', leagueId).eq('team_id', teamId),
    supabase.from('league_trades').insert({ league_id:leagueId, seller_id:req.user.id, team_id:teamId, price:execPrice, qty }),
  ]);

  res.json({ type:'market', execPrice, qty, proceeds });
});

// ---- Portfolio de la ligue ----
router.get('/:id/portfolio', requireAuth, async (req, res) => {
  const leagueId = req.params.id;
  const { data: member } = await supabase.from('league_members').select('cash').eq('league_id', leagueId).eq('user_id', req.user.id).single();
  const { data: holdings } = await supabase.from('league_holdings').select('*, teams(name,color)').eq('league_id', leagueId).eq('user_id', req.user.id).gt('shares', 0);
  const { data: prices } = await supabase.from('league_team_prices').select('team_id, price').eq('league_id', leagueId);
  const priceMap = Object.fromEntries((prices || []).map(p => [p.team_id, p.price]));
  const positions = (holdings || []).map(h => ({ ...h, currentPrice: priceMap[h.team_id] || EMISSION_PRICE, value: h.shares * (priceMap[h.team_id] || EMISSION_PRICE) }));
  const stockVal = positions.reduce((s, p) => s + p.value, 0);
  res.json({ cash: member?.cash || 0, stockValue: stockVal, totalValue: (member?.cash || 0) + stockVal, positions });
});

// ---- Classement ----
router.get('/:id/leaderboard', async (req, res) => {
  const leagueId = req.params.id;
  const { data: members } = await supabase.from('league_members').select('user_id, cash, profiles(username, badge)').eq('league_id', leagueId);
  const { data: prices } = await supabase.from('league_team_prices').select('team_id, price').eq('league_id', leagueId);
  const priceMap = Object.fromEntries((prices || []).map(p => [p.team_id, p.price]));
  const ranked = await Promise.all((members || []).map(async m => {
    const { data: hlds } = await supabase.from('league_holdings').select('shares, team_id').eq('league_id', leagueId).eq('user_id', m.user_id);
    const stockVal = (hlds || []).reduce((s, h) => s + h.shares * (priceMap[h.team_id] || EMISSION_PRICE), 0);
    return { userId: m.user_id, username: m.profiles?.username, badge: m.profiles?.badge, cash: m.cash, stockValue: stockVal, netWorth: m.cash + stockVal };
  }));
  res.json(ranked.sort((a, b) => b.netWorth - a.netWorth));
});

// ---- Impact log ----
router.get('/:id/impact-log', async (req, res) => {
  const { data } = await supabase.from('league_price_impacts').select('*, teams(name,color)').eq('league_id', req.params.id).order('created_at', { ascending:false }).limit(50);
  res.json(data || []);
});

// ---- Dividendes reçus ----
router.get('/:id/dividends', requireAuth, async (req, res) => {
  const { data } = await supabase.from('league_dividend_payments').select('*').eq('league_id', req.params.id).eq('user_id', req.user.id).order('paid_at', { ascending:false }).limit(50);
  res.json(data || []);
});

module.exports = router;
