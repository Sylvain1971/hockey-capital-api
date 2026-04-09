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

  // Initialiser les prix AMM avec les vrais prix du marché LNH
  const { data: teams } = await supabase.from('teams').select('id');
  const { data: currentPrices } = await supabase.from('current_prices').select('team_id, price');
  const currentPriceMap = Object.fromEntries((currentPrices || []).map(p => [p.team_id, parseFloat(p.price)]));
  const priceInserts = teams.map(t => ({
    league_id: league.id, team_id: t.id,
    price: currentPriceMap[t.id] || EMISSION_PRICE,
    amm_reserve: Math.floor(SHARES_PER_TEAM * AMM_RESERVE_PCT),
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

// ---- Supprimer une ligue (créateur seulement) ----
router.delete('/:id', requireAuth, async (req, res) => {
  const { data: league } = await supabase.from('leagues').select('creator_id').eq('id', req.params.id).single();
  if (!league) return res.status(404).json({ error: 'Ligue introuvable' });
  if (league.creator_id !== req.user.id) return res.status(403).json({ error: 'Seul le createur peut supprimer la ligue' });
  await supabase.from('league_members').delete().eq('league_id', req.params.id);
  await supabase.from('league_invitations').delete().eq('league_id', req.params.id);
  await supabase.from('leagues').delete().eq('id', req.params.id);
  res.json({ message: 'Ligue supprimee' });
});

// ---- Membres d'une ligue ----
router.get('/:id/members', requireAuth, async (req, res) => {
  const leagueId = req.params.id;
  const { data } = await supabase
    .from('league_members')
    .select('user_id, cash, is_creator, profiles(username, display_name)')
    .eq('league_id', leagueId);

  // Vrais prix du marché LNH pour valoriser les actions
  const { data: marketPrices } = await supabase.from('current_prices').select('team_id, price');
  const priceMap = Object.fromEntries((marketPrices || []).map(p => [p.team_id, parseFloat(p.price)]));

  // Calculer la valeur totale pour chaque membre (cash + valeur actions au prix marché)
  const members = await Promise.all((data || []).map(async m => {
    const { data: holdings } = await supabase
      .from('league_holdings')
      .select('team_id, shares, avg_cost')
      .eq('league_id', leagueId)
      .eq('user_id', m.user_id)
      .gt('shares', 0);

    const stockValue = (holdings || []).reduce((s, h) => {
      const price = priceMap[h.team_id] || h.avg_cost || 0;
      return s + h.shares * price;
    }, 0);

    const cash = parseFloat(m.cash || 0);
    const netWorth = cash + stockValue;

    return {
      user_id: m.user_id,
      username: m.profiles?.display_name || m.profiles?.username || 'Joueur',
      cash,
      stock_value: stockValue,
      net_worth: netWorth,
      is_creator: m.is_creator,
    };
  }));

  // Trier par valeur totale décroissante
  members.sort((a, b) => b.net_worth - a.net_worth);
  res.json(members);
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
  const { data: league } = await supabase.from('leagues').select('amm_spread_pct, algo_config, capital_virtuel').eq('id', leagueId).single();

  // Prix d'exécution = vrai prix du marché LNH (current_prices), pas le prix AMM de la ligue
  const { data: marketPrice } = await supabase.from('current_prices').select('price').eq('team_id', teamId).single();
  const spread = ((lp?.amm_spread_pct || league?.amm_spread_pct || 2)) / 100;
  const refPrice = parseFloat(marketPrice?.price || lp?.price || EMISSION_PRICE);
  const execPrice = orderType === 'limit' && limitPrice ? parseFloat(limitPrice) : parseFloat((refPrice * (1 + spread / 2)).toFixed(4));
  const cost = parseFloat((execPrice * qty).toFixed(4));

  if (cost > member.cash) return res.status(400).json({ error: 'Liquidités insuffisantes' });
  if (qty > (lp?.amm_reserve || SHARES_PER_TEAM * AMM_RESERVE_PCT)) return res.status(400).json({ error: 'Pas assez d\'actions disponibles' });

  // ---- Règle de concentration : max 40% du portefeuille par équipe ----
  const { data: allHoldings } = await supabase
    .from('league_holdings').select('team_id, shares')
    .eq('league_id', leagueId).eq('user_id', req.user.id).gt('shares', 0);
  const { data: allPrices } = await supabase
    .from('league_team_prices').select('team_id, price').eq('league_id', leagueId);
  const priceMap = Object.fromEntries((allPrices || []).map(p => [p.team_id, parseFloat(p.price)]));

  // Valeur totale du portefeuille après achat
  const stockVal = (allHoldings || []).reduce((s, h) => s + h.shares * (priceMap[h.team_id] || refPrice), 0);
  const portfolioTotal = member.cash - cost + stockVal + cost; // cash restant + stocks actuels + nouvel achat

  // Valeur de la position sur cette équipe après achat
  const currentHolding = (allHoldings || []).find(h => h.team_id === teamId);
  const currentShares = currentHolding?.shares || 0;
  const newPositionValue = (currentShares + qty) * execPrice;
  const concentrationPct = newPositionValue / portfolioTotal;

  if (concentrationPct > 0.40) {
    const maxShares = Math.floor((portfolioTotal * 0.40 - currentShares * execPrice) / execPrice);
    return res.status(400).json({
      error: `Limite de concentration dépassée: max 40% du portefeuille par équipe. Vous pouvez acheter au maximum ${Math.max(0, maxShares)} action(s) supplémentaire(s) de ${teamId}.`,
      code: 'CONCENTRATION_LIMIT',
      maxShares: Math.max(0, maxShares),
      concentrationPct: Math.round(concentrationPct * 100),
    });
  }

  // ---- Règle des 3 équipes minimum avant de dépasser 25% ----
  const nbEquipes = new Set([
    ...(allHoldings || []).filter(h => h.shares > 0).map(h => h.team_id),
    teamId,
  ]).size;

  if (concentrationPct > 0.25 && nbEquipes < 3) {
    return res.status(400).json({
      error: `Pour investir plus de 25% dans une équipe, vous devez détenir au moins 3 équipes différentes. Vous en avez ${nbEquipes}.`,
      code: 'MIN_DIVERSIFICATION',
      nbEquipes,
    });
  }
  // ----------------------------------------------------------------

  if (orderType === 'limit') {
    await supabase.from('league_orders').insert({ league_id:leagueId, user_id:req.user.id, team_id:teamId, side:'buy', price:execPrice, qty, status:'open' });
    await supabase.from('league_members').update({ cash: member.cash - cost }).eq('league_id', leagueId).eq('user_id', req.user.id);
    return res.json({ type:'limit_placed', execPrice, qty, cost });
  }

  // Exécution marché immédiate via AMM
  const existingHolding = (allHoldings || []).find(h => h.team_id === teamId);
  const existingShares = existingHolding?.shares || 0;
  const newShares = existingShares + qty;
  const existingAvgCost = existingHolding?.avg_cost || execPrice;
  // Nouveau coût moyen pondéré
  const newAvgCost = existingShares > 0
    ? ((existingAvgCost * existingShares) + (execPrice * qty)) / newShares
    : execPrice;

  await Promise.all([
    supabase.from('league_members').update({ cash: member.cash - cost }).eq('league_id', leagueId).eq('user_id', req.user.id),
    supabase.from('league_team_prices').update({ amm_reserve: (lp?.amm_reserve || 7000) - qty }).eq('league_id', leagueId).eq('team_id', teamId),
    supabase.from('league_holdings').upsert(
      { league_id:leagueId, user_id:req.user.id, team_id:teamId, shares: newShares, avg_cost: parseFloat(newAvgCost.toFixed(4)) },
      { onConflict: 'league_id,user_id,team_id' }
    ),
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

  // Prix d'exécution = vrai prix du marché LNH
  const { data: marketPrice } = await supabase.from('current_prices').select('price').eq('team_id', teamId).single();
  const spread = ((lp?.amm_spread_pct || league?.amm_spread_pct || 2)) / 100;
  const refPrice = parseFloat(marketPrice?.price || lp?.price || EMISSION_PRICE);
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

  // Prix actuels du marché LNH
  const { data: marketPrices } = await supabase.from('current_prices').select('team_id, price');
  const priceMap = Object.fromEntries((marketPrices || []).map(p => [p.team_id, parseFloat(p.price)]));

  // Prix d'ouverture du jour pour calculer la variation journalière
  const today = new Date().toISOString().split('T')[0];
  const { data: openPrices } = await supabase.from('daily_open_prices').select('team_id, price').eq('date', today);
  const openMap = Object.fromEntries((openPrices || []).map(p => [p.team_id, parseFloat(p.price)]));

  const positions = (holdings || []).map(h => {
    const currentPrice = priceMap[h.team_id] || h.avg_cost || EMISSION_PRICE;
    const value = h.shares * currentPrice;

    // P&L du jour = variation depuis l'ouverture (pas depuis l'achat)
    // Si pas de prix d'ouverture (acheté aujourd'hui), P&L = 0
    const openPrice = openMap[h.team_id];
    const pnl = openPrice ? (currentPrice - openPrice) * h.shares : 0;
    const pnlPct = openPrice && openPrice > 0 ? ((currentPrice - openPrice) / openPrice * 100) : 0;

    // P&L total depuis l'achat (pour info)
    const pnlTotal = value - (h.shares * (h.avg_cost || currentPrice));

    return { ...h, currentPrice, value, pnl, pnlPct, pnlTotal };
  });
  const stockVal = positions.reduce((s, p) => s + p.value, 0);
  res.json({ cash: member?.cash || 0, stockValue: stockVal, totalValue: (member?.cash || 0) + stockVal, positions });
});

// ---- Classement ----
router.get('/:id/leaderboard', async (req, res) => {
  const leagueId = req.params.id;
  const { data: members } = await supabase.from('league_members').select('user_id, cash, profiles(username, badge)').eq('league_id', leagueId);

  // Vrais prix du marché LNH pour le classement
  const { data: marketPrices } = await supabase.from('current_prices').select('team_id, price');
  const priceMap = Object.fromEntries((marketPrices || []).map(p => [p.team_id, parseFloat(p.price)]));

  const ranked = await Promise.all((members || []).map(async m => {
    const { data: hlds } = await supabase.from('league_holdings').select('shares, team_id, avg_cost').eq('league_id', leagueId).eq('user_id', m.user_id);
    const stockVal = (hlds || []).reduce((s, h) => s + h.shares * (priceMap[h.team_id] || h.avg_cost || EMISSION_PRICE), 0);
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
