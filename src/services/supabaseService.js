'use strict';
/**
 * Hockey Capital — Service Supabase
 * Toutes les opérations sur la base de données
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // clé service (pas anon) pour les jobs backend
);

// ---- PRIX ----

async function getCurrentPrice(teamId) {
  const { data, error } = await supabase
    .from('current_prices')
    .select('price')
    .eq('team_id', teamId)
    .single();
  if (error) throw error;
  return parseFloat(data.price);
}

async function getAllPrices() {
  const { data, error } = await supabase
    .from('current_prices')
    .select('*');
  if (error) throw error;
  return data;
}

async function updatePrice(teamId, newPrice, volume = 0) {
  const { error } = await supabase
    .from('team_prices')
    .insert({ team_id: teamId, price: newPrice, volume_24h: volume });
  if (error) throw error;
}

async function logPriceImpact(teamId, trigger, description, oldPrice, newPrice) {
  const pctChange = ((newPrice - oldPrice) / oldPrice * 100).toFixed(3);
  const { error } = await supabase
    .from('price_impact_log')
    .insert({ team_id: teamId, trigger, description, old_price: oldPrice, new_price: newPrice, pct_change: pctChange });
  if (error) console.error('logPriceImpact error:', error);
}

// ---- STATS LNH ----

async function getNHLStats(teamId) {
  const { data, error } = await supabase
    .from('nhl_team_stats')
    .select('*')
    .eq('team_id', teamId)
    .single();
  if (error) throw error;
  return data;
}

async function updateNHLStats(teamId, updates) {
  const { error } = await supabase
    .from('nhl_team_stats')
    .update({ ...updates, last_updated: new Date().toISOString() })
    .eq('team_id', teamId);
  if (error) throw error;
}

async function markClinchBonusPaid(teamId) {
  await updateNHLStats(teamId, { clinch_bonus_paid: true });
}

// ---- DIVIDENDES ----

async function payDividend({ teamId, amountPerShare, reason, gameId, streakAtTime, multiplier }) {
  // 1. Enregistrer le dividende
  const { data: div, error: divErr } = await supabase
    .from('dividends')
    .insert({
      team_id: teamId,
      amount_per_share: amountPerShare,
      reason,
      game_id: gameId,
      streak_at_time: streakAtTime,
      multiplier,
    })
    .select()
    .single();
  if (divErr) throw divErr;

  // 2. Récupérer tous les actionnaires au moment du snapshot
  const { data: holders, error: holdErr } = await supabase
    .from('holdings')
    .select('user_id, shares')
    .eq('team_id', teamId)
    .gt('shares', 0);
  if (holdErr) throw holdErr;
  if (!holders || holders.length === 0) return { paid: 0, holders: 0 };

  // 3. Verser le dividende + enregistrer les paiements
  let totalPaid = 0;
  for (const holder of holders) {
    const amount = parseFloat((amountPerShare * holder.shares).toFixed(4));
    totalPaid += amount;

    // Créditer le cash
    await supabase.rpc('increment_cash', { p_user_id: holder.user_id, p_amount: amount });

    // Log du paiement
    await supabase.from('dividend_payments').insert({
      dividend_id: div.id,
      user_id: holder.user_id,
      team_id: teamId,
      shares_held: holder.shares,
      amount,
    });
  }

  return { paid: totalPaid, holders: holders.length };
}

// ---- ORDRES & TRADES ----

async function getOpenOrders(teamId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('team_id', teamId)
    .eq('status', 'open')
    .order('price', { ascending: true });
  if (error) throw error;
  return data;
}

async function placeOrder({ userId, teamId, side, orderType, price, qty }) {
  // Vérifications
  const { data: profile } = await supabase.from('profiles').select('cash').eq('id', userId).single();
  const { data: supply } = await supabase.from('team_supply').select('available').eq('team_id', teamId).single();
  const currentPrice = await getCurrentPrice(teamId);
  const tradePrice = orderType === 'market' ? currentPrice : price;

  if (side === 'buy') {
    const cost = tradePrice * qty;
    if (profile.cash < cost) throw new Error('Liquidités insuffisantes');
    if (supply.available < qty) throw new Error('Actions insuffisantes sur le marché');
  } else {
    const { data: holding } = await supabase.from('holdings').select('shares')
      .eq('user_id', userId).eq('team_id', teamId).single();
    if (!holding || holding.shares < qty) throw new Error('Vous ne détenez pas assez d\'actions');
  }

  if (orderType === 'market') {
    // Exécution immédiate
    return executeTrade({ userId, teamId, side, price: currentPrice, qty });
  } else {
    // Ordre limité → réserver les fonds / actions
    const { data: order, error } = await supabase
      .from('orders')
      .insert({ user_id: userId, team_id: teamId, side, order_type: 'limit', price, qty })
      .select().single();
    if (error) throw error;
    if (side === 'buy') {
      await supabase.rpc('increment_cash', { p_user_id: userId, p_amount: -(price * qty) });
    }
    return order;
  }
}

async function executeTrade({ userId, teamId, side, price, qty, orderId = null }) {
  const cost = price * qty;

  if (side === 'buy') {
    // Débiter le cash
    await supabase.rpc('increment_cash', { p_user_id: userId, p_amount: -cost });
    // Mettre à jour le holding
    await upsertHolding(userId, teamId, qty, price);
    // Réduire le supply
    await supabase.from('team_supply').update({ available: supabase.raw('available - ' + qty) }).eq('team_id', teamId);
    // Enregistrer la trade
    await supabase.from('trades').insert({ buyer_id: userId, team_id: teamId, price, qty, order_id: orderId });
  } else {
    // Créditer le cash
    await supabase.rpc('increment_cash', { p_user_id: userId, p_amount: cost });
    // Réduire le holding
    await upsertHolding(userId, teamId, -qty, price);
    // Augmenter le supply
    await supabase.from('team_supply').update({ available: supabase.raw('available + ' + qty) }).eq('team_id', teamId);
    // Enregistrer la trade
    await supabase.from('trades').insert({ seller_id: userId, team_id: teamId, price, qty, order_id: orderId });
  }

  // Mettre à jour le volume
  await supabase.from('team_prices')
    .update({ volume_24h: supabase.raw('volume_24h + ' + qty) })
    .eq('team_id', teamId)
    .order('recorded_at', { ascending: false })
    .limit(1);

  await supabase.rpc('update_badge', { p_user_id: userId });
  return { success: true, price, qty, total: cost };
}

async function upsertHolding(userId, teamId, deltaShares, tradePrice) {
  const { data: existing } = await supabase
    .from('holdings').select('shares, avg_cost').eq('user_id', userId).eq('team_id', teamId).single();

  if (!existing) {
    if (deltaShares > 0) {
      await supabase.from('holdings').insert({ user_id: userId, team_id: teamId, shares: deltaShares, avg_cost: tradePrice });
    }
    return;
  }

  const newShares = existing.shares + deltaShares;
  let newAvgCost = existing.avg_cost;
  if (deltaShares > 0) {
    newAvgCost = ((existing.avg_cost * existing.shares) + (tradePrice * deltaShares)) / newShares;
  }

  await supabase.from('holdings')
    .update({ shares: Math.max(0, newShares), avg_cost: newAvgCost, updated_at: new Date().toISOString() })
    .eq('user_id', userId).eq('team_id', teamId);
}

// ---- PORTFOLIO ----

async function getPortfolio(userId) {
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
  const { data: holdings } = await supabase.from('holdings').select('*, teams(name, color, division)').eq('user_id', userId).gt('shares', 0);
  const prices = await getAllPrices();
  const priceMap = Object.fromEntries(prices.map(p => [p.team_id, parseFloat(p.price)]));

  let stockValue = 0;
  let costBasis = 0;
  const positions = (holdings || []).map(h => {
    const currentPrice = priceMap[h.team_id] || 0;
    const value = currentPrice * h.shares;
    const cost = h.avg_cost * h.shares;
    stockValue += value;
    costBasis += cost;
    return { ...h, currentPrice, value, cost, pnl: value - cost, pnlPct: ((value - cost) / cost * 100).toFixed(2) };
  });

  return {
    cash: parseFloat(profile.cash),
    stockValue,
    totalValue: parseFloat(profile.cash) + stockValue,
    pnl: stockValue - costBasis,
    badge: profile.badge,
    positions,
  };
}

// ---- LEADERBOARD ----

async function getLeaderboard(limit = 20) {
  const { data: profiles } = await supabase.from('profiles').select('id, username, display_name, cash, badge');
  const prices = await getAllPrices();
  const priceMap = Object.fromEntries(prices.map(p => [p.team_id, parseFloat(p.price)]));

  const ranked = await Promise.all(profiles.map(async p => {
    const { data: holdings } = await supabase.from('holdings').select('shares, team_id').eq('user_id', p.id);
    const stockValue = (holdings || []).reduce((sum, h) => sum + h.shares * (priceMap[h.team_id] || 0), 0);
    return { ...p, stockValue, netWorth: parseFloat(p.cash) + stockValue, teamsHeld: (holdings || []).filter(h => h.shares > 0).length };
  }));

  return ranked.sort((a, b) => b.netWorth - a.netWorth).slice(0, limit);
}

module.exports = {
  supabase,
  getCurrentPrice, getAllPrices, updatePrice, logPriceImpact,
  getNHLStats, updateNHLStats, markClinchBonusPaid,
  payDividend,
  getOpenOrders, placeOrder, executeTrade,
  getPortfolio, getLeaderboard,
};
