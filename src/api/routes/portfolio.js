'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getPortfolio, supabase } = require('../../services/supabaseService');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await getPortfolio(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dividends', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('dividend_payments')
    .select('*, dividends(reason, multiplier, streak_at_time), teams(name, color)')
    .eq('user_id', req.user.id)
    .order('paid_at', { ascending: false })
    .limit(50);
  res.json(data || []);
});

module.exports = router;
