/**
 * Hockey Capital — Moteur de prix VERSION 2.0
 * 
 * PARAMÈTRES DU MARCHÉ:
 * - Valeur d'équipe: 3 000 000 000 $ CAD (moyenne réelle 2026)
 * - Actions en circulation: 120 000 000 par équipe
 * - Prix de base: 25.00 $ (3B / 120M)
 * 
 * ALGORITHME DE VARIATION:
 * 1. Performance (standings): +/- selon points et rang
 * 2. Momentum (win streak): bonus multiplicateur
 * 3. Offre/demande simulée: prime pour équipes populaires
 * 4. Séries éliminatoires: bonus qualification
 * 5. Tendance de fond: réversion vers la moyenne
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://xbciytfwuqawlbnowhve.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiY2l5dGZ3dXFhd2xibm93aHZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTU4NzYzMywiZXhwIjoyMDkxMTYzNjMzfQ.H1B3frayDLQuIDe7qNsyWFhjG6-6xb-6zxpXrmfS9pQ'
);

// ============================================================
// CONSTANTES ÉCONOMIQUES
// ============================================================
const BASE_PRICE = 25.00;          // Prix émission = 3B$ / 120M actions
const TOTAL_SHARES = 120_000_000;  // Actions en circulation par équipe
const TEAM_VALUE_CAD = 3_000_000_000; // Valeur moyenne équipe LNH en $CAD 2026

// ============================================================
// ALGORITHME DE PRIX
// Calcule le prix actuel basé sur les performances depuis début saison
// ============================================================
function calculatePrice(stats) {
  const {
    points = 0,
    wins = 0,
    losses = 0,
    ot_losses = 0,
    division_rank = 8,
    win_streak = 0,
    games_played = 0,
  } = stats;

  if (games_played === 0) return BASE_PRICE;

  // 1. FACTEUR PERFORMANCE (points relatifs à la moyenne)
  // Moyenne ~95 pts sur 82 matchs, ratio points/match attendu = 1.16
  const expectedPts = games_played * 1.16;
  const perfRatio = expectedPts > 0 ? (points - expectedPts) / expectedPts : 0;
  // Impact: +/- 35% max selon performance
  const perfImpact = Math.max(-0.35, Math.min(0.35, perfRatio * 1.2));

  // 2. FACTEUR RANG DIVISIONNAIRE
  // #1 = +8%, #2 = +4%, #3 = +2%, #4 = 0%, #5 = -2%, #6-8 = -4%
  const rankBonus = [0.08, 0.04, 0.02, 0, -0.02, -0.04, -0.04, -0.04][Math.min(division_rank - 1, 7)] || -0.04;

  // 3. FACTEUR MOMENTUM (streak)
  // Série positive: prime, série négative: escompte
  let streakFactor = 0;
  if (win_streak >= 7)       streakFactor = 0.06;
  else if (win_streak >= 5)  streakFactor = 0.04;
  else if (win_streak >= 3)  streakFactor = 0.02;
  else if (win_streak <= -7) streakFactor = -0.06;
  else if (win_streak <= -5) streakFactor = -0.04;
  else if (win_streak <= -3) streakFactor = -0.02;

  // 4. EFFET OFFRE/DEMANDE SIMULÉ
  // Les équipes dans le top 8 (qualifiées séries) ont une prime de liquidité
  // Les marchés anticipent les séries = hausse préventive
  const inPlayoffs = division_rank <= 3 || (points >= 85 && games_played >= 70);
  const demandPremium = inPlayoffs ? 0.05 : (division_rank <= 5 ? 0.02 : 0);

  // 5. FACTEUR VOLATILITÉ (bruit de marché)
  // Simule les mouvements journaliers normaux (+/- 0.5%)
  // Basé sur le hash de l'équipe pour être reproductible
  const noiseSeed = (points * 7 + wins * 3 + division_rank * 13) % 100;
  const noise = ((noiseSeed / 100) - 0.5) * 0.01; // +/- 0.5%

  // 6. RATIO VICTOIRES/DÉFAITES (taux de victoire)
  const gp = wins + losses + ot_losses;
  const winRate = gp > 0 ? wins / gp : 0.5;
  const winRateFactor = (winRate - 0.5) * 0.20; // +/- 10% selon win rate

  // PRIX FINAL
  const totalFactor = 1 + perfImpact + rankBonus + streakFactor + demandPremium + noise + winRateFactor;
  const price = BASE_PRICE * Math.max(0.40, Math.min(2.50, totalFactor)); // plancher $10, plafond $62.50

  return Math.round(price * 100) / 100;
}

// ============================================================
// ACTUALISATION DU MARCHÉ
// ============================================================
async function updateMarket() {
  console.log('=== HOCKEY CAPITAL — MOTEUR DE PRIX v2.0 ===');
  console.log(`Prix de base: $${BASE_PRICE} | ${TOTAL_SHARES.toLocaleString()} actions | Valeur: $${(TEAM_VALUE_CAD/1e9).toFixed(1)}B CAD`);
  console.log('');

  // 1. Fetch standings LNH en temps réel
  console.log('📡 Fetch standings LNH...');
  const res = await fetch('https://api-web.nhle.com/v1/standings/now');
  const data = await res.json();
  const standings = data.standings || [];
  console.log(`   ${standings.length} équipes reçues\n`);

  const NHL_TO_HC = {
    MTL:'MTL',BOS:'BOS',TOR:'TOR',TBL:'TBL',FLA:'FLA',OTT:'OTT',BUF:'BUF',DET:'DET',
    NYR:'NYR',PHI:'PHI',PIT:'PIT',WSH:'WSH',NJD:'NJD',NYI:'NYI',CAR:'CAR',CBJ:'CBJ',
    CHI:'CHI',NSH:'NSH',STL:'STL',COL:'COL',MIN:'MIN',DAL:'DAL',WPG:'WPG',UTA:'UTA',
    VGK:'VGK',EDM:'EDM',CGY:'CGY',VAN:'VAN',SEA:'SEA',SJS:'SJS',ANA:'ANA',LAK:'LAK',
  };

  let updated = 0;
  const results = [];

  for (const s of standings) {
    const teamId = NHL_TO_HC[s.teamAbbrev?.default];
    if (!teamId) continue;

    const gp = (s.wins || 0) + (s.losses || 0) + (s.otLosses || 0);

    // Récupérer le streak actuel depuis la DB
    const { data: currentStats } = await supabase
      .from('nhl_team_stats')
      .select('win_streak')
      .eq('team_id', teamId)
      .single();

    const stats = {
      points: s.points || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      ot_losses: s.otLosses || 0,
      division_rank: s.divisionSequence || 8,
      win_streak: currentStats?.win_streak || 0,
      games_played: gp,
    };

    const newPrice = calculatePrice(stats);

    // Mettre à jour nhl_team_stats
    await supabase.from('nhl_team_stats').upsert({
      team_id: teamId,
      wins: stats.wins,
      losses: stats.losses,
      ot_losses: stats.ot_losses,
      points: stats.points,
      division_rank: stats.division_rank,
      clinch_bonus_paid: false,
      last_updated: new Date().toISOString(),
    }, { onConflict: 'team_id' });

    // Insérer nouveau point de prix dans l'historique
    await supabase.from('team_prices').insert({
      team_id: teamId,
      price: newPrice,
      volume_24h: 0,
    });

    // Mettre à jour team_supply (changer de 100 à 120M)
    await supabase.from('team_supply').upsert({
      team_id: teamId,
      available: TOTAL_SHARES,
    }, { onConflict: 'team_id' });

    results.push({ teamId, price: newPrice, pts: stats.points, rank: stats.division_rank, streak: stats.win_streak });
    updated++;
  }

  // Trier par prix décroissant pour affichage
  results.sort((a, b) => b.price - a.price);

  console.log('📈 PRIX CALCULÉS (ordre décroissant):');
  console.log('─'.repeat(55));
  for (const r of results) {
    const arrow = r.price > BASE_PRICE ? '▲' : r.price < BASE_PRICE ? '▼' : '─';
    const diff = ((r.price - BASE_PRICE) / BASE_PRICE * 100).toFixed(1);
    const sign = diff > 0 ? '+' : '';
    console.log(`  ${r.teamId.padEnd(4)} $${r.price.toFixed(2).padStart(6)} ${arrow} ${sign}${diff}% | ${r.pts}pts #${r.rank} streak:${r.streak}`);
  }
  console.log('─'.repeat(55));

  const avgPrice = results.reduce((s, r) => s + r.price, 0) / results.length;
  const maxPrice = Math.max(...results.map(r => r.price));
  const minPrice = Math.min(...results.map(r => r.price));
  const totalMarketCap = results.reduce((s, r) => s + r.price * TOTAL_SHARES, 0);

  console.log(`\n📊 STATISTIQUES DU MARCHÉ:`);
  console.log(`   Prix moyen:      $${avgPrice.toFixed(2)}`);
  console.log(`   Prix max:        $${maxPrice.toFixed(2)}`);
  console.log(`   Prix min:        $${minPrice.toFixed(2)}`);
  console.log(`   Cap. totale:     $${(totalMarketCap/1e9).toFixed(2)}B`);
  console.log(`   Équipes > $25:   ${results.filter(r => r.price > 25).length}/32`);
  console.log(`   Équipes < $25:   ${results.filter(r => r.price < 25).length}/32`);
  console.log(`\n✅ ${updated} équipes mises à jour`);
}

updateMarket().catch(console.error);
