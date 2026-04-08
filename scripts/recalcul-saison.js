'use strict';
/**
 * RECALCUL COMPLET SAISON 2025-2026
 * Repart de $25.00 pour toutes les équipes le 8 octobre 2025
 * Retraite tous les matchs jusqu'à aujourd'hui
 * Recalcule les prix finaux + daily_open_prices
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BASE_URL = 'https://api-web.nhle.com/v1';
const PRIX_DEPART = 25.00;
const SEASON_START = '2025-10-08';

const ALGO = {
  WIN_REG: 0.04, WIN_OT: 0.02, SHUTOUT_BONUS: 0.03,
  LOSS_REG: 0.03, LOSS_OT: 0.01,
  STREAK_MULT: [1.0, 1.0, 1.0, 1.5, 1.5, 2.0, 2.0, 3.0],
  RANK_1_DAILY: 0.015 / 7,
  RANK_23_DAILY: 0.005 / 7,
  RANK_9_DAILY: -0.010 / 7,
  PRICE_FLOOR: 0.50,
};

function streakMult(streak) {
  if (streak >= 7) return 3.0;
  if (streak >= 5) return 2.0;
  if (streak >= 3) return 1.5;
  return 1.0;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function getAllDates(start, end) {
  const dates = [];
  let cur = start;
  while (cur <= end) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

async function fetchGames(date) {
  try {
    const r = await fetch(`${BASE_URL}/score/${date}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.games || []).filter(g => g.gameState === 'OFF' || g.gameState === 'FINAL');
  } catch { return []; }
}

async function fetchStandings(date) {
  try {
    // L'API standings/now retourne le classement actuel
    // Pour historique, on utilise standings par date si disponible
    const r = await fetch(`${BASE_URL}/standings/${date}`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.standings || [];
  } catch { return []; }
}

function parseGame(g) {
  const homeAbbr = g.homeTeam?.abbrev;
  const awayAbbr = g.awayTeam?.abbrev;
  const homeGoals = g.homeTeam?.score ?? 0;
  const awayGoals = g.awayTeam?.score ?? 0;
  const periodType = g.periodDescriptor?.periodType;
  const isOT = periodType === 'OT' || periodType === 'SO';
  const homeWon = homeGoals > awayGoals;

  return {
    gameId: String(g.id),
    home: {
      teamId: homeAbbr,
      won: homeWon,
      overtime: isOT,
      shutout: homeWon && awayGoals === 0,
    },
    away: {
      teamId: awayAbbr,
      won: !homeWon,
      overtime: isOT,
      shutout: !homeWon && homeGoals === 0,
    },
  };
}

async function main() {
  console.log('=== RECALCUL SAISON 2025-2026 ===');
  console.log(`Prix de départ: $${PRIX_DEPART} pour toutes les équipes`);
  console.log(`Période: ${SEASON_START} → ${today()}`);
  console.log('');

  // 1. Charger toutes les équipes
  const { data: teams } = await supabase.from('teams').select('id');
  const teamIds = teams.map(t => t.id);
  console.log(`${teamIds.length} équipes trouvées`);

  // 2. État initial: tous à $25.00, streaks à 0
  const prices = {};
  const streaks = {};  // positif = win streak, négatif = loss streak
  const clinchPaid = {};
  const dailyOpen = {}; // date -> { teamId -> price }

  for (const id of teamIds) {
    prices[id] = PRIX_DEPART;
    streaks[id] = 0;
    clinchPaid[id] = false;
  }

  // 3. Vider les tables existantes
  console.log('\nNettoyage des tables...');
  await supabase.from('team_prices').delete().neq('team_id', 'XXXXXX');
  await supabase.from('price_impact_log').delete().neq('team_id', 'XXXXXX');
  console.log('Tables vidées');

  // 4. Insérer le prix de départ pour toutes les équipes (1er octobre comme référence)
  const openPrices = teamIds.map(id => ({
    team_id: id,
    price: PRIX_DEPART,
    volume_24h: 0,
    recorded_at: '2025-10-07T23:59:00.000Z',
  }));
  await supabase.from('team_prices').insert(openPrices);
  console.log(`Prix d'ouverture $${PRIX_DEPART} insérés pour toutes les équipes`);

  // 5. Itérer sur chaque jour de la saison
  const dates = getAllDates(SEASON_START, today());
  console.log(`\nTraitement de ${dates.length} jours...`);

  let totalGames = 0;
  const impactLogs = [];
  const priceRows = [];

  for (const date of dates) {
    const games = await fetchGames(date);
    if (games.length === 0) continue;

    // Snapshot du prix d'ouverture du jour
    dailyOpen[date] = {};
    for (const id of teamIds) dailyOpen[date][id] = prices[id];

    // Traiter chaque match
    for (const g of games) {
      const parsed = parseGame(g);

      for (const side of [parsed.home, parsed.away]) {
        const { teamId, won, overtime, shutout } = side;
        if (!teamId || !prices[teamId]) continue;

        const oldPrice = prices[teamId];
        const currentStreak = streaks[teamId];
        const winStreak = Math.max(0, currentStreak);

        // Calcul impact
        let pct = 0;
        if (won) {
          const newStreak = winStreak + 1;
          const base = overtime ? ALGO.WIN_OT : ALGO.WIN_REG;
          pct += base * streakMult(newStreak);
          if (shutout) pct += ALGO.SHUTOUT_BONUS;
          streaks[teamId] = won ? Math.max(1, currentStreak) + (currentStreak > 0 ? 1 : 1) : 0;
          streaks[teamId] = currentStreak >= 0 ? currentStreak + 1 : 1;
        } else {
          pct -= overtime ? ALGO.LOSS_OT : ALGO.LOSS_REG;
          streaks[teamId] = currentStreak <= 0 ? currentStreak - 1 : -1;
        }

        const newPrice = Math.max(ALGO.PRICE_FLOOR, parseFloat((oldPrice * (1 + pct)).toFixed(4)));
        prices[teamId] = newPrice;
        const pctChange = parseFloat(((newPrice - oldPrice) / oldPrice * 100).toFixed(3));

        priceRows.push({
          team_id: teamId,
          price: newPrice,
          volume_24h: 0,
          recorded_at: `${date}T22:00:00.000Z`,
        });

        impactLogs.push({
          team_id: teamId,
          trigger: 'game_result',
          description: `${won ? (overtime ? 'Victoire OT/FP' : 'Victoire régulière') : (overtime ? 'Défaite OT/FP' : 'Défaite régulière')}${shutout && won ? ' + blanchissage' : ''} [${g.id}]`,
          old_price: oldPrice,
          new_price: newPrice,
          pct_change: pctChange,
          created_at: `${date}T22:00:00.000Z`,
        });
      }

      totalGames++;
    }

    process.stdout.write(`\r${date}: ${totalGames} matchs traités`);
  }

  console.log('\n');
  console.log(`Total matchs traités: ${totalGames}`);

  // 6. Insérer en batch dans team_prices
  console.log(`Insertion de ${priceRows.length} lignes de prix...`);
  const chunkSize = 500;
  for (let i = 0; i < priceRows.length; i += chunkSize) {
    await supabase.from('team_prices').insert(priceRows.slice(i, i + chunkSize));
    process.stdout.write(`\r  ${Math.min(i + chunkSize, priceRows.length)}/${priceRows.length}`);
  }

  // 7. Insérer les impact logs
  console.log(`\nInsertion de ${impactLogs.length} impact logs...`);
  for (let i = 0; i < impactLogs.length; i += chunkSize) {
    await supabase.from('price_impact_log').insert(impactLogs.slice(i, i + chunkSize));
    process.stdout.write(`\r  ${Math.min(i + chunkSize, impactLogs.length)}/${impactLogs.length}`);
  }

  // 8. Mettre à jour current_prices (table de prix actuel)
  console.log('\n\nMise à jour des prix finaux...');
  for (const [teamId, price] of Object.entries(prices)) {
    await supabase.from('team_prices').insert({
      team_id: teamId,
      price,
      volume_24h: 0,
      recorded_at: new Date().toISOString(),
    });
  }

  // 9. Rapport final
  console.log('\n=== RÉSULTATS FINAUX ===');
  const sorted = Object.entries(prices).sort((a, b) => b[1] - a[1]);
  for (const [id, price] of sorted) {
    const pct = ((price - PRIX_DEPART) / PRIX_DEPART * 100).toFixed(1);
    const bar = price > PRIX_DEPART ? '+' : '';
    console.log(`${id.padEnd(4)} $${price.toFixed(2).padStart(6)} (${bar}${pct}% depuis oct. 2025)`);
  }

  console.log('\n✅ Recalcul terminé!');
}

main().catch(console.error);
