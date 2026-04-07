'use strict';
// ============================================================
// middleware/auth.js
// ============================================================
const { supabase } = require('../../services/supabaseService');

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token invalide' });
  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const { data } = await supabase.from('profiles').select('badge').eq('id', req.user.id).single();
    if (data?.badge !== 'Admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
