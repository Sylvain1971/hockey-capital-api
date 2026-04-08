'use strict';
const express = require('express');
const { supabaseAuth, supabase } = require('../../services/supabaseService');
const router = express.Router();

// Inscription
router.post('/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username)
    return res.status(400).json({ error: 'Champs requis manquants' });
  if (username.length < 3 || username.length > 30)
    return res.status(400).json({ error: 'Username: 3-30 caracteres' });

  const emailClean = email.toLowerCase().trim();

  // Verifier whitelist admin (createurs de ligue)
  const { data: allowed } = await supabase
    .from('allowed_emails').select('email')
    .eq('email', emailClean).single();

  // Verifier invitation de ligue (joueurs invites)
  const { data: invitation } = await supabase
    .from('league_invitations').select('id, league_id, used')
    .eq('email', emailClean).eq('used', false)
    .order('invited_at', { ascending: false })
    .limit(1).single();

  if (!allowed && !invitation) {
    return res.status(403).json({
      error: 'Acces sur invitation seulement. Demandez un code au createur de votre ligue.'
    });
  }

  const { data, error } = await supabaseAuth.auth.signUp({
    email, password,
    options: { data: { username, display_name: username } },
  });
  if (error) return res.status(400).json({ error: error.message });

  const userId = data.user?.id;

  // Si invite: rejoindre toutes les ligues en attente pour cet email
  if (userId) {
    const { data: pendingInvites } = await supabase
      .from('league_invitations').select('id, league_id')
      .eq('email', emailClean).eq('used', false);

    for (const inv of pendingInvites || []) {
      const { data: league } = await supabase
        .from('leagues').select('*').eq('id', inv.league_id).single();
      if (league && league.status === 'open') {
        await supabase.from('league_members').upsert({
          league_id: league.id, user_id: userId,
          cash: league.capital_virtuel, is_creator: false,
        }, { onConflict: 'league_id,user_id' });
        await supabase.from('league_invitations')
          .update({ used: true }).eq('id', inv.id);
      }
    }
  }

  res.json({ message: 'Compte cree!', userId });
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
