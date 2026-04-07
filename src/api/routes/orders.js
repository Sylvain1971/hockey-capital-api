'use strict';
// ============================================================
// routes/orders.js
// ============================================================
const express = require('express');
const { placeOrder, supabase } = require('../../services/supabaseService');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Placer un ordre (achat ou vente)
router.post('/place', requireAuth, async (req, res) => {
  const { teamId, side, orderType, price, qty } = req.body;
  if (!teamId || !side || !orderType || !qty) return res.status(400).json({ error: 'Paramètres manquants' });
  if (!['buy','sell'].includes(side)) return res.status(400).json({ error: 'side invalide' });
  if (!['market','limit'].includes(orderType)) return res.status(400).json({ error: 'orderType invalide' });
  if (orderType === 'limit' && !price) return res.status(400).json({ error: 'Prix requis pour ordre limité' });

  try {
    const result = await placeOrder({ userId: req.user.id, teamId: teamId.toUpperCase(), side, orderType, price, qty });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Annuler un ordre
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!order) return res.status(404).json({ error: 'Ordre introuvable' });
    if (order.status !== 'open') return res.status(400).json({ error: 'Ordre déjà exécuté ou annulé' });

    // Rembourser si ordre d'achat limité
    if (order.side === 'buy' && order.order_type === 'limit') {
      const remaining = order.qty - order.qty_filled;
      await supabase.rpc('increment_cash', { p_user_id: req.user.id, p_amount: order.price * remaining });
    }
    await supabase.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ message: 'Ordre annulé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mes ordres actifs
router.get('/mine', requireAuth, async (req, res) => {
  const { data } = await supabase.from('orders').select('*').eq('user_id', req.user.id).eq('status', 'open').order('created_at', { ascending: false });
  res.json(data || []);
});

// Historique des transactions
router.get('/history', requireAuth, async (req, res) => {
  const { data: bought } = await supabase.from('trades').select('*, teams(name,color)').eq('buyer_id', req.user.id).order('executed_at', { ascending: false }).limit(50);
  const { data: sold }   = await supabase.from('trades').select('*, teams(name,color)').eq('seller_id', req.user.id).order('executed_at', { ascending: false }).limit(50);
  const all = [
    ...(bought || []).map(t => ({ ...t, type: 'Achat' })),
    ...(sold   || []).map(t => ({ ...t, type: 'Vente' })),
  ].sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
  res.json(all.slice(0, 50));
});

module.exports = router;

// ============================================================
// routes/portfolio.js  (exporté séparément ci-dessous)
// ============================================================
const portfolioRouter = express.Router();
const { getPortfolio } = require('../../services/supabaseService');

portfolioRouter.get('/', requireAuth, async (req, res) => {
  try {
    const data = await getPortfolio(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mes dividendes reçus
portfolioRouter.get('/dividends', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('dividend_payments')
    .select('*, dividends(reason, multiplier, streak_at_time), teams(name, color)')
    .eq('user_id', req.user.id)
    .order('paid_at', { ascending: false })
    .limit(50);
  res.json(data || []);
});

// Exporter les deux routers
module.exports.ordersRouter = router;
module.exports.portfolioRouter = portfolioRouter;
