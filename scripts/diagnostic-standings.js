'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  console.log('=== DIAGNOSTIC DES DÉGÂTS (bug standings) ===\n');

  // 1. Quand le bug a-t-il commencé ? Premier impact 'standings' d'aujourd'hui
  const { data: firstStandings } = await supabase
    .from('price_impact_log')
    .select('created_at, team_id, pct_change')
    .eq('trigger', 'standings')
    .order('created_at', { ascending: true })
    .limit(1);

  // 2. Dernier impact 'standings'
  const { data: lastStandings } = await supabase
    .from('price_impact_log')
    .select('created_at')
    .eq('trigger', 'standings')
    .order('created_at', { ascending: false })
    .limit(1);

  console.log('Premier impact standings:', firstStandings?.[0]?.created_at);
  console.log('Dernier impact standings:', lastStandings?.[0]?.created_at);

  // 3. Combien d'impacts standings au total
  const { count: totalStandings } = await supabase
    .from('price_impact_log')
    .select('id', { count: 'exact' })
    .eq('trigger', 'standings');

  console.log('Nombre total impacts standings:', totalStandings);

  // 4. Prix actuels vs prix qui devraient être là (dernier game_result par équipe)
  console.log('\n=== PRIX ACTUELS vs PRIX ATTENDUS ===');

  const { data: currentPrices } = await supabase
    .from('current_prices')
    .select('team_id, price')
    .order('team_id');

  // Dernier prix AVANT le premier impact standings (= prix correct)
  const bugStart = firstStandings?.[0]?.created_at;

  const { data: lastGameResults } = await supabase
    .from('price_impact_log')
    .select('team_id, new_price, created_at')
    .eq('trigger', 'game_result')
    .lt('created_at', bugStart || new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(200);

  // Garder le dernier game_result par équipe avant le bug
  const correctPrices = {};
  for (const row of (lastGameResults || [])) {
    if (!correctPrices[row.team_id]) {
      correctPrices[row.team_id] = parseFloat(row.new_price);
    }
  }

  // Si pas de game_result avant le bug, utiliser le prix de départ $25
  const PRIX_DEPART = 25.00;

  let totalDrift = 0;
  let teamsAffected = 0;

  for (const cp of (currentPrices || [])) {
    const current = parseFloat(cp.price);
    const correct = correctPrices[cp.team_id] || PRIX_DEPART;
    const drift = ((current - correct) / correct * 100).toFixed(2);
    if (Math.abs(parseFloat(drift)) > 0.1) {
      console.log(`${cp.team_id.padEnd(4)}: actuel $${current.toFixed(2).padStart(8)} | correct $${correct.toFixed(2).padStart(8)} | dérive ${drift}%`);
      totalDrift += Math.abs(parseFloat(drift));
      teamsAffected++;
    }
  }

  console.log(`\n${teamsAffected} équipes affectées, dérive moyenne: ${teamsAffected > 0 ? (totalDrift / teamsAffected).toFixed(2) : 0}%`);
  console.log('\nBugStart (premier standings):', bugStart);
}

main().catch(console.error);
