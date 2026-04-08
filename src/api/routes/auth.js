'use strict';
const express = require('express');
const { supabaseAuth, supabase } = require('../../services/supabaseService');
const router = express.Router();

// Inscription
router.post('/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'Champs requis manquants' });
  if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username: 3-30 caracteres' });

  // Verifier la whitelist
  const { data: allowed } = await supabase
    .from('allowed_emails')
    .select('email')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!allowed) {
    return res.status(403).json({ error: 'Acces sur invitation seulement. Contactez l administrateur.' });
  }

  const { data, error } = await supabaseAuth.auth.signUp({
    email, password,
    options: { data: { username, display_name: username } },
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Compte cree!', userId: data.user?.id });
});

// Connexion
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Identifiants invalides' });
  res.json({ token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
});

// Deconnexion
router.post('/logout', async (req, res) => {
  await supabaseAuth.auth.signOut();
  res.json({ message: 'Deconnecte' });
});

module.exports = router;
