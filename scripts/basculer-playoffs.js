'use strict';
/**
 * basculer-playoffs.js
 * Bascule season_config vers le mode séries et initialise les équipes.
 *
 * Usage:
 *   node scripts/basculer-playoffs.js --round=1   ← début des séries
 *   node scripts/basculer-playoffs.js --round=2   ← ronde 2
 *   node scripts/basculer-playoffs.js --round=3   ← finale de conférence
 *   node scripts/basculer-playoffs.js --round=4   ← finale Stanley
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const arg = process.argv.find(a => a.startsWith('--round='));
const round = arg ? parseInt(arg.split('=')[1]) : null;

if (!round || round < 1 || round > 4) {
  console.error('❌ Usage: node scripts/basculer-playoffs.js --round=1');
  process.exit(1);
}

const ROUND_LABELS = { 1: 'Ronde 1', 2: 'Ronde 2', 3: 'Finale de conférence', 4: 'Finale Stanley' };

async function run() {
  console.log(`🏒 Basculement → Séries éliminatoires — ${ROUND_LABELS[round]}`);

  const now = new Date().toISOString();

  // 1. Mettre à jour season_config
  const { error: cfgErr } = await supabase.from('season_config').update({
    mode: 'playoffs',
    playoff_round: round,
    playoffs_started_at: round === 1 ? now : undefined,
    updated_at: now,
  }).eq('id', 1);

  if (cfgErr) { console.error('❌ Erreur season_config:', cfgErr.message); process.exit(1); }
  console.log(`✅ season_config → mode=playoffs, round=${round}`);

  // 2. Si ronde 1 : initialiser toutes les équipes qualifiées / non qualifiées
  if (round === 1) {
    // Récupérer les 32 équipes
    const { data: teams } = await supabase.from('teams').select('id, playoff_status');

    // Les équipes avec playoff_status = 'active' sont les 16 qualifiées (set manuellement avant)
    // Les autres passent à not_qualified avec eliminated_at = now
    let qualified = 0, notQualified = 0;

    for (const team of teams || []) {
      if (team.playoff_status === 'active') {
        // Déjà marquée active — réinitialiser les compteurs de série
        await supabase.from('nhl_team_stats').update({
          playoff_series_wins: 0, playoff_series_losses: 0,
        }).eq('team_id', team.id);
        qualified++;
      } else {
        // Non qualifiée — figer le marché
        await supabase.from('teams').update({
          playoff_status: 'not_qualified',
          playoff_locked: true,
          eliminated_at: now,
        }).eq('id', team.id);
        notQualified++;
      }
    }
    console.log(`✅ ${qualified} équipes actives, ${notQualified} équipes figées (not_qualified)`);
  }

  // 3. Si ronde 2+ : avancer la ronde des équipes encore actives
  if (round > 1) {
    const { data: active } = await supabase
      .from('teams').select('id').eq('playoff_status', 'active');

    for (const team of active || []) {
      await supabase.from('teams').update({ playoff_round: round }).eq('id', team.id);
      await supabase.from('nhl_team_stats').update({
        playoff_series_wins: 0, playoff_series_losses: 0,
      }).eq('team_id', team.id);
    }
    console.log(`✅ ${active?.length || 0} équipes avancées à la ronde ${round}`);
  }

  console.log(`\n🏒 Basculement terminé — ${ROUND_LABELS[round]} en cours`);
  process.exit(0);
}

run();
