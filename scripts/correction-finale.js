'use strict';
/**
 * CORRECTION FINALE DES PRIX
 * Remet chaque équipe à son dernier prix légitime (dernier game_result)
 * Nettoie TOUS les standings frauduleux (toute la journée du 2026-04-09)
 * Propage aux ligues
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BUG_START = '2026-04-09T17:39:00Z';
const BUG_END   = '2099-01-01T00:00:00Z'; // tout ce qui est après le bug

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== CORRECTION FINALE PRIX ===\n');

  // 0. Vérifier que Railway a bien arrêté d'écrire des standings
  const { data: recents } = await sb.from('price_impact_log')
    .select('created_at').eq('trigger', 'standings')
    .gte('created_at', new Date(Date.now() - 60000).toISOString())
    .limit(3);
  if (recents?.length > 0) {
    console.log('ATTENTION: Railway écrit encore des standings (', recents.length, 'dans la dernière minute)');
    console.log('Attente 30s supplémentaires...');
    await sleep(30000);
  } else {
    console.log('Railway stable — aucun standings récent. On peut corriger.\n');
  }

  // 1. Toutes les équipes
  const { data: teams } = await sb.from('teams').select('id');
  const teamIds = teams.map(t => t.id);

  // 2. Prix légitimes = dernier game_result OU clinch AVANT le bug
  const corrections = [];
  for (const teamId of teamIds) {
    const { data: legit } = await sb.from('price_impact_log')
      .select('new_price, trigger, created_at')
      .eq('team_id', teamId)
      .in('trigger', ['game_result', 'clinch', 'playoff_game', 'sweep', 'champion', 'eliminated'])
      .lt('created_at', BUG_START)
      .order('created_at', { ascending: false })
      .limit(1);

    if (legit?.length > 0) {
      corrections.push({ teamId, prix: parseFloat(legit[0].new_price), ref: legit[0].trigger, at: legit[0].created_at.substring(0,10) });
    } else {
      // Aucun match — garder $25 (prix de départ recalcul)
      corrections.push({ teamId, prix: 25.00, ref: 'depart', at: '2025-10-08' });
    }
  }

  // 3. Appliquer corrections sur current_prices
  console.log('--- Correction current_prices ---');
  const now = new Date().toISOString();
  for (const c of corrections) {
    const { data: avant } = await sb.from('current_prices').select('price').eq('team_id', c.teamId).single();
    const prixAvant = parseFloat(avant?.price || 0);
    const diff = prixAvant > 0 ? ((c.prix - prixAvant) / prixAvant * 100).toFixed(1) : 'N/A';
    await sb.from('current_prices')
      .upsert({ team_id: c.teamId, price: c.prix, updated_at: now }, { onConflict: 'team_id' });
    console.log(`${c.teamId.padEnd(4)} $${prixAvant.toFixed(2).padStart(8)} → $${c.prix.toFixed(2).padStart(8)} (${diff}%) [${c.ref} @ ${c.at}]`);
  }

  // 4. Supprimer TOUS les standings frauduleux (toute la journée)
  console.log('\n--- Suppression standings frauduleux ---');
  let total = 0, continuer = true;
  while (continuer) {
    const { data: batch } = await sb.from('price_impact_log')
      .select('id').eq('trigger', 'standings')
      .gte('created_at', BUG_START).limit(500);
    if (!batch?.length) { continuer = false; break; }
    await sb.from('price_impact_log').delete().in('id', batch.map(r => r.id));
    total += batch.length;
    process.stdout.write(`\r  Supprimé ${total}...`);
    if (batch.length < 500) continuer = false;
  }
  console.log(`\n  Total : ${total} entrées standings supprimées`);

  // 5. Supprimer team_prices frauduleux
  console.log('\n--- Suppression team_prices frauduleux ---');
  total = 0; continuer = true;
  while (continuer) {
    const { data: batch } = await sb.from('team_prices')
      .select('id').gte('recorded_at', BUG_START).limit(500);
    if (!batch?.length) { continuer = false; break; }
    await sb.from('team_prices').delete().in('id', batch.map(r => r.id));
    total += batch.length;
    process.stdout.write(`\r  Supprimé ${total}...`);
    if (batch.length < 500) continuer = false;
  }
  console.log(`\n  Total : ${total} lignes team_prices supprimées`);

  // 6. Propager vers les ligues
  console.log('\n--- Propagation vers les ligues ---');
  const { data: leagues } = await sb.from('leagues').select('id, name').eq('status', 'open');
  for (const lg of (leagues || [])) {
    for (const c of corrections) {
      await sb.from('league_team_prices')
        .update({ price: c.prix })
        .eq('league_id', lg.id).eq('team_id', c.teamId);
    }
    // Supprimer league_price_impacts frauduleux
    let lTotal = 0, lContinuer = true;
    while (lContinuer) {
      const { data: batch } = await sb.from('league_price_impacts')
        .select('id').eq('league_id', lg.id)
        .gte('created_at', BUG_START).limit(500);
      if (!batch?.length) { lContinuer = false; break; }
      await sb.from('league_price_impacts').delete().in('id', batch.map(r => r.id));
      lTotal += batch.length;
      if (batch.length < 500) lContinuer = false;
    }
    console.log(`  ${lg.name} : ${corrections.length} prix corrigés, ${lTotal} impacts supprimés`);
  }

  // 7. Insérer une entrée de traçabilité
  await sb.from('price_impact_log').insert(corrections.map(c => ({
    team_id: c.teamId, trigger: 'admin_correction',
    description: `Correction bug standings-loop 2026-04-09 → restauré depuis ${c.ref}@${c.at}`,
    new_price: c.prix, pct_change: 0, created_at: now,
  })));

  // 8. Vérification finale
  console.log('\n=== VÉRIFICATION FINALE ===');
  const { data: final } = await sb.from('current_prices').select('team_id, price');
  const check = { COL:156.82, BUF:80.18, CAR:67.95, EDM:30.89, DAL:70.99, TBL:75.46, MTL:48.41 };
  let ok = true;
  for (const [id, cible] of Object.entries(check)) {
    const t = final?.find(p => p.team_id === id);
    const actuel = parseFloat(t?.price || 0);
    const match = Math.abs(actuel - cible) < 0.5;
    if (!match) ok = false;
    console.log(`${id} : $${actuel.toFixed(2)} (cible $${cible.toFixed(2)}) ${match ? '✓' : '✗'}`);
  }
  // Vérifier qu'aucun nouveau standings n'est apparu pendant le fix
  const { data: postFix } = await sb.from('price_impact_log')
    .select('id').eq('trigger', 'standings').gte('created_at', now).limit(1);
  if (postFix?.length) {
    console.log('\n⚠️  ATTENTION: Railway a écrit des standings pendant le fix — relancer ce script!');
  } else {
    console.log(ok ? '\n✅ Tous les prix corrects — marché stable!' : '\n⚠️  Certains prix encore incorrects — vérifier Railway');
  }
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
