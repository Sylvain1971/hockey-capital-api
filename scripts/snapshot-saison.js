'use strict';
/**
 * snapshot-saison.js
 * Script one-shot à exécuter AVANT de basculer en mode séries.
 * Copie le prix courant de chaque équipe dans season_close_price,
 * et récupère les points + rang de conférence depuis les standings NHL.
 *
 * Usage: node scripts/snapshot-saison.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchStandings } = require('../src/services/nhlApi');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  console.log('📸 Snapshot saison régulière — début');

  // 1. Récupérer les standings NHL finaux
  let standings;
  try {
    standings = await fetchStandings();
    console.log(`✅ ${standings.length} équipes récupérées de l'API NHL`);
  } catch (err) {
    console.error('❌ Erreur fetch standings:', err.message);
    process.exit(1);
  }

  // 2. Pour chaque équipe, snapshot prix + pts + rang
  let ok = 0, errors = 0;
  for (const team of standings) {
    try {
      // Prix courant
      const { data: cp } = await supabase
        .from('current_prices').select('price').eq('team_id', team.teamId).single();
      if (!cp) { console.warn(`⚠️  Pas de prix pour ${team.teamId}`); errors++; continue; }

      // Calculer le rang de conférence depuis le tableau standings
      // On trie par points décroissants dans la même conférence
      const confTeams = standings
        .filter(t => t.conference === team.conference)
        .sort((a, b) => b.points - a.points);
      const confRank = confTeams.findIndex(t => t.teamId === team.teamId) + 1;

      await supabase.from('teams').update({
        season_close_price: parseFloat(cp.price),
        season_pts:         team.points || 0,
        conference_rank:    confRank,
      }).eq('id', team.teamId);

      console.log(`  ${team.teamId}: $${cp.price} | ${team.points}pts | conf. #${confRank}`);
      ok++;
    } catch (err) {
      console.error(`  ❌ ${team.teamId}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n✅ Snapshot terminé — ${ok} équipes OK, ${errors} erreurs`);
  process.exit(errors > 0 ? 1 : 0);
}

run();
