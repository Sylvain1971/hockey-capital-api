'use strict';
const express = require('express');
const { supabaseAuth } = require('../../services/supabaseService');
const router = express.Router();

// Inscription
router.post('/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'Champs requis manquants' });
  if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username: 3–30 caractères' });

  const { data, error } = await supabaseAuth.auth.signUp({
    email, password,
    options: { data: { username, display_name: username } },
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Compte créé!', userId: data.user?.id });
});

// Connexion
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Identifiants invalides' });
  res.json({ token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
});

// Déconnexion
router.post('/logout', async (req, res) => {
  await supabaseAuth.auth.signOut();
  res.json({ message: 'Déconnecté' });
});

module.exports = router;
