'use strict';
/**
 * Hockey Capital â€” Job de traitement LNH v2.0
 * Lit season_config.mode au dÃ©marrage â†’ choisit la stratÃ©gie regular ou playoffs
 */

const { fetchScores, fetchStandings } = require('./nhlApi');
const {
  applyGameResult, applyStandingsAdjustment, applyPlayoffClinch,
  applyPlayoffGameResult, applyElimination, applyPlayoffSweep,
  applyPlayoffComeback, applyUpsetseries, applyChampion, detectUpset,
} = require('./priceImpact');
const { detectPlayoffEvents, logPlayoffEvent } = require('./playoffEvents');
const {
  getCurrentPrice, updatePrice, logPriceImpact,
  getNHLStats, updateNHLStats, markClinchBonusPaid,
  payDividend, supabase,
} = require('./supabaseService');

const processedGames = new Set();

// â”€â”€ Config globale (chargÃ©e au dÃ©marrage et rechargÃ©e si besoin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let seasonConfig = { mode: 'regular', playoff_round: null };

async function loadSeasonConfig() {
  const { data } = await supabase.from('season_config').select('*').eq('id', 1).single();
  if (data) seasonConfig = data;
  return seasonConfig;
}

// â”€â”€ Helpers partagÃ©s â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function isGameProcessed(gameId) {
  if (processedGames.has(gameId)) return true;
  const { data } = await supabase
    .from('price_impact_log').select('id')
    .eq('trigger', 'game_result').like('description', `%[${gameId}]%`).limit(1);
  return data && data.length > 0;
}

async function snapshotOpenPrice(teamId, currentPrice) {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('daily_open_prices').select('team_id')
    .eq('team_id', teamId).eq('date', today).limit(1);
  if (!data || data.length === 0) {
    await supabase.from('daily_open_prices').insert({ team_id: teamId, price: currentPrice, date: today });
  }
}

async function propagatePriceToLeagues(teamId, newPrice, pctChange) {
  try {
    const { data: leagues } = await supabase.from('leagues').select('id').eq('status', 'open');
    if (!leagues || leagues.length === 0) return;
    for (const league of leagues) {
      await supabase.from('league_team_prices').update({ price: newPrice }).eq('league_id', league.id).eq('team_id', teamId);
      if (pctChange !== 0) {
        await supabase.from('league_price_impacts').insert({
          league_id: league.id, team_id: teamId, pct_change: pctChange,
          description: `Impact LNH: ${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(3)}%`,
        });
      }
    }
  } catch (e) { console.error('[LEAGUES] Erreur propagation prix:', e.message); }
}

// â”€â”€ SAISON RÃ‰GULIÃˆRE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processScores(broadcast = null) {
  let games;
  try { games = await fetchScores(); }
  catch (err) { console.error('[NHL] Erreur fetch scores:', err.message); return; }

  for (const game of games) {
    if (!game.isFinal) continue;
    if (processedGames.has(game.gameId)) continue;
    if (await isGameProcessed(game.gameId)) { processedGames.add(game.gameId); continue; }

    for (const result of [game.homeResult, game.awayResult]) {
      if (!result?.teamId) continue;
      const { data: cp } = await supabase.from('current_prices').select('price').eq('team_id', result.teamId).single().catch(() => ({ data: null }));
      if (cp) await snapshotOpenPrice(result.teamId, parseFloat(cp.price));
    }
    processedGames.add(game.gameId);

    for (const result of [game.homeResult, game.awayResult]) {
      if (!result?.teamId) continue;
      await processTeamGameResult(result, game.gameId, broadcast);
    }
  }
}

async function processTeamGameResult(result, gameId, broadcast) {
  const { teamId, won, overtime, shutout } = result;
  try {
    const stats        = await getNHLStats(teamId);
    const currentPrice = await getCurrentPrice(teamId);
    const currentStreak = stats.win_streak || 0;
    const winStreak = won ? Math.max(0, currentStreak) + 1 : 0;
    const newStreak = won ? winStreak : (Math.min(0, currentStreak) - 1);

    const impact = applyGameResult({ won, overtime, shutout, winStreak: Math.max(0, currentStreak) }, currentPrice);
    await updatePrice(teamId, impact.newPrice);
    await logPriceImpact(teamId, impact.log.trigger, `${impact.log.description} [${gameId}]`, currentPrice, impact.newPrice);
    await propagatePriceToLeagues(teamId, impact.newPrice, impact.pctChange);

    const statUpdate = {
      win_streak: newStreak,
      last_game_result: won ? (overtime ? 'OTW' : 'W') : (overtime ? 'OTL' : 'L'),
      last_game_was_shutout: shutout,
      games_played: (stats.games_played || 0) + 1,
    };
    if (won)      statUpdate.wins = (stats.wins || 0) + 1;
    else if (overtime) statUpdate.ot_losses = (stats.ot_losses || 0) + 1;
    else          statUpdate.losses = (stats.losses || 0) + 1;
    await updateNHLStats(teamId, statUpdate);

    if (won && impact.dividend > 0) {
      try {
        await payDividend({ teamId, amountPerShare: impact.dividend, reason: impact.log.description, gameId,
          streakAtTime: winStreak, multiplier: winStreak >= 7 ? 3 : winStreak >= 5 ? 2 : winStreak >= 3 ? 1.5 : 1 });
      } catch (e) { console.error(`[DIV] Erreur ${teamId}:`, e.message); }
    }
    if (broadcast) broadcast({ type: 'PRICE_UPDATE', teamId, newPrice: impact.newPrice, pctChange: impact.pctChange, reason: impact.log.description, dividend: impact.dividend });
    console.log(`[PRIX] ${teamId}: $${currentPrice} â†’ $${impact.newPrice} (${impact.pctChange >= 0 ? '+' : ''}${impact.pctChange}%)`);
  } catch (err) { console.error(`[GAME] Erreur ${teamId}:`, err.message); }
}

async function processStandings(broadcast = null) {
  let standings;
  try { standings = await fetchStandings(); }
  catch (err) { console.error('[NHL] Erreur fetch standings:', err.message); return; }

  for (const team of standings) {
    if (!team.teamId) continue;
    try {
      const currentPrice = await getCurrentPrice(team.teamId);
      await snapshotOpenPrice(team.teamId, currentPrice);
      const adj = applyStandingsAdjustment(team.divisionRank, currentPrice, true);
      if (adj.pctChange !== 0) {
        await updatePrice(team.teamId, adj.newPrice);
        await logPriceImpact(team.teamId, adj.log.trigger, adj.log.description, currentPrice, adj.newPrice);
        await propagatePriceToLeagues(team.teamId, adj.newPrice, adj.pctChange);
      }
      await updateNHLStats(team.teamId, { wins: team.wins, losses: team.losses, ot_losses: team.otLosses,
        points: team.points, games_played: team.gamesPlayed, division_rank: team.divisionRank,
        goals_for: team.goalsFor, goals_against: team.goalsAgainst, clinched: team.clinched });

      const stats = await getNHLStats(team.teamId);
      if (team.clinched && !stats.clinch_bonus_paid) {
        const clinchImpact = applyPlayoffClinch(currentPrice);
        await updatePrice(team.teamId, clinchImpact.newPrice);
        await logPriceImpact(team.teamId, 'clinch', clinchImpact.log.description, currentPrice, clinchImpact.newPrice);
        await markClinchBonusPaid(team.teamId);
        if (broadcast) broadcast({ type: 'CLINCH', teamId: team.teamId, newPrice: clinchImpact.newPrice, pctChange: clinchImpact.pctChange });
      }
      if (broadcast && adj.pctChange !== 0) broadcast({ type: 'PRICE_UPDATE', teamId: team.teamId, newPrice: adj.newPrice, pctChange: adj.pctChange, reason: adj.log.description });
    } catch (err) { console.error(`[STANDINGS] Erreur ${team.teamId}:`, err.message); }
  }
}

// â”€â”€ SÃ‰RIES Ã‰LIMINATOIRES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Job principal sÃ©ries â€” remplace processScores() quand mode = 'playoffs'
 */
async function processPlayoffScores(broadcast = null) {
  await loadSeasonConfig();
  const round = seasonConfig.playoff_round || 1;
  let games;
  try { games = await fetchScores(); }
  catch (err) { console.error('[PLAYOFFS] Erreur fetch scores:', err.message); return; }

  for (const game of games) {
    if (!game.isFinal) continue;
    if (processedGames.has(game.gameId)) continue;
    if (await isGameProcessed(game.gameId)) { processedGames.add(game.gameId); continue; }

    processedGames.add(game.gameId);

    for (const result of [game.homeResult, game.awayResult]) {
      if (!result?.teamId) continue;

      // VÃ©rifier que l'Ã©quipe est encore active en sÃ©ries
      const { data: teamData } = await supabase
        .from('teams').select('playoff_status, playoff_locked, season_pts, conference_rank')
        .eq('id', result.teamId).single();

      if (!teamData || teamData.playoff_status !== 'active' || teamData.playoff_locked) {
        console.log(`[PLAYOFFS] ${result.teamId} ignorÃ© (statut: ${teamData?.playoff_status})`);
        continue;
      }

      await processTeamPlayoffResult(result, game, round, teamData, broadcast);
    }
  }
}

async function processTeamPlayoffResult(result, game, round, teamData, broadcast) {
  const { teamId, won, overtime } = result;
  try {
    const currentPrice = await getCurrentPrice(teamId);
    await snapshotOpenPrice(teamId, currentPrice);

    // Trouver les donnÃ©es de l'adversaire pour le calcul d'upset
    const opponentResult = game.homeResult?.teamId === teamId ? game.awayResult : game.homeResult;
    let opponentData = {};
    if (opponentResult?.teamId) {
      const { data } = await supabase.from('teams').select('season_pts, conference_rank').eq('id', opponentResult.teamId).single();
      if (data) opponentData = data;
    }

    // Impact par match avec multiplicateur de ronde + upset
    const impact = applyPlayoffGameResult({
      won, overtime, round,
      thisTeam: { season_pts: teamData.season_pts, conference_rank: teamData.conference_rank },
      opponent: { season_pts: opponentData.season_pts, conference_rank: opponentData.conference_rank },
    }, currentPrice);

    await updatePrice(teamId, impact.newPrice);
    await logPriceImpact(teamId, impact.log.trigger, `${impact.log.description} [${game.gameId}]`, currentPrice, impact.newPrice);
    await propagatePriceToLeagues(teamId, impact.newPrice, impact.pctChange);

    // RÃ©cupÃ©rer Ã©tat sÃ©rie courant depuis les stats
    const stats = await getNHLStats(teamId);
    const seriesWins   = (stats.playoff_series_wins   || 0) + (won ? 1 : 0);
    const seriesLosses = (stats.playoff_series_losses || 0) + (won ? 0 : 1);
    const wasDown03 = !won ? false : (stats.playoff_series_wins === 0 && stats.playoff_series_losses === 3);
    const isChampionshipRound = round === 4;

    await updateNHLStats(teamId, { playoff_series_wins: seriesWins, playoff_series_losses: seriesLosses });

    // DÃ©tecter et appliquer les Ã©vÃ©nements one-shot
    const events = await detectPlayoffEvents({
      teamId, round, seriesWins, seriesLosses, isChampionshipRound,
      thisTeam: { season_pts: teamData.season_pts, conference_rank: teamData.conference_rank },
      opponent: { season_pts: opponentData.season_pts, conference_rank: opponentData.conference_rank },
      wasDown03,
    });

    let latestPrice = impact.newPrice;

    for (const event of events) {
      let eventImpact;
      const { detectUpset } = require('./priceImpact');
      const { coeff } = detectUpset(
        { season_pts: teamData.season_pts, conference_rank: teamData.conference_rank },
        { season_pts: opponentData.season_pts, conference_rank: opponentData.conference_rank }
      );

      if (event.type === 'sweep')           eventImpact = applyPlayoffSweep(latestPrice);
      else if (event.type === 'comeback_0_3')  eventImpact = applyPlayoffComeback(latestPrice, coeff);
      else if (event.type === 'upset_series_win') eventImpact = applyUpsetseries(latestPrice, coeff, event.forWinner !== false);
      else if (event.type === 'champion')   eventImpact = applyChampion(latestPrice);
      else if (event.type === 'eliminated') eventImpact = applyElimination(latestPrice);

      if (!eventImpact) continue;
      latestPrice = eventImpact.newPrice;
      await updatePrice(teamId, latestPrice);
      await logPriceImpact(teamId, event.type, eventImpact.log.description, impact.newPrice, latestPrice);
      await logPlayoffEvent({ teamId, eventType: event.type, priceImpact: event.priceImpact, round, upsetCoeff: event.upsetCoeff });
      await propagatePriceToLeagues(teamId, latestPrice, eventImpact.pctChange);

      // Figer le marchÃ© si Ã©limination ou champion
      if (event.type === 'eliminated' || event.type === 'champion') {
        await supabase.from('teams').update({
          playoff_locked: true,
          playoff_status: event.type === 'champion' ? 'champion' : 'eliminated',
          eliminated_at: new Date().toISOString(),
        }).eq('id', teamId);
        console.log(`[PLAYOFFS] ${teamId} ${event.type === 'champion' ? 'ðŸ† Champion!' : 'Ã©liminÃ©'} â€” marchÃ© figÃ©`);
      }

      if (broadcast) broadcast({ type: event.type.toUpperCase(), teamId, newPrice: latestPrice, pctChange: eventImpact.pctChange, round });
    }

    if (broadcast) broadcast({ type: 'PRICE_UPDATE', teamId, newPrice: latestPrice, pctChange: impact.pctChange, reason: impact.log.description });
    console.log(`[PLAYOFFS R${round}] ${teamId}: $${currentPrice} â†’ $${latestPrice} (${impact.pctChange >= 0 ? '+' : ''}${impact.pctChange}%)`);

  } catch (err) { console.error(`[PLAYOFFS] Erreur ${teamId}:`, err.message); }
}

// â”
// â”€â”€ Basculement automatique saison â†’ sÃ©ries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * DÃ©tecte automatiquement la fin de saison rÃ©guliÃ¨re via l'API NHL.
 * AppelÃ© Ã  chaque cycle en mode 'regular'.
 *
 * Logique :
 *  - L'API NHL retourne gameType=3 pour les matchs de sÃ©ries
 *  - Quand on dÃ©tecte un match de type 3 terminÃ©, c'est que les sÃ©ries ont commencÃ©
 *  - On dÃ©clenche alors le basculement complet automatiquement
 */
async function checkAutoBasculement(broadcast = null) {
  try {
    const BASE = 'https://api-web.nhle.com/v1';
    const today = new Date().toISOString().split('T')[0];

    // VÃ©rifier s'il y a des matchs de sÃ©ries aujourd'hui (gameType 3)
    const res = await fetch(`${BASE}/score/${today}`);
    if (!res.ok) return;
    const data = await res.json();
    const games = data.games || [];

    // Chercher aussi la veille (matchs tardifs)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    const resY = await fetch(`${BASE}/score/${yStr}`);
    const dataY = resY.ok ? await resY.json() : { games: [] };
    const allGames = [...games, ...(dataY.games || [])];

    // Un match de sÃ©ries est gameType === 3
    const hasPlayoffGame = allGames.some(g => g.gameType === 3);
    if (!hasPlayoffGame) return; // Saison rÃ©guliÃ¨re encore en cours

    console.log('[AUTO-BASCULEMENT] ðŸ’ Matchs de sÃ©ries dÃ©tectÃ©s â€” dÃ©marrage du basculement automatique!');
    await executerBasculementAuto(broadcast);

  } catch (err) {
    console.error('[AUTO-BASCULEMENT] Erreur dÃ©tection:', err.message);
  }
}

/**
 * ExÃ©cute le basculement complet vers le mode sÃ©ries.
 * AppelÃ© automatiquement lors de la dÃ©tection du premier match de sÃ©ries.
 */
async function executerBasculementAuto(broadcast = null) {
  const now = new Date().toISOString();
  console.log('[AUTO-BASCULEMENT] DÃ©but Ã ', now);

  try {
    // 1. RÃ©cupÃ©rer standings finaux de saison rÃ©guliÃ¨re
    const BASE = 'https://api-web.nhle.com/v1';
    const res = await fetch(`${BASE}/standings/now`);
    const data = res.ok ? await res.json() : { standings: [] };
    const standings = data.standings || [];

    // 2. Identifier les qualifiÃ©s (clinchIndicator prÃ©sent et !== 'e')
    //    'e' = Ã©liminÃ©, 'x'/'y'/'z' = qualifiÃ©, sans indicateur = encore en jeu
    const { NHL_TO_HC } = require('./nhlApi');
    const qualified = [];
    const confRanks = {};
    const teamPts = {};

    // Trier par leagueSequence pour avoir le rang correct
    const sorted = [...standings].sort((a, b) => (a.leagueSequence||99) - (b.leagueSequence||99));

    // Top 16 du classement ligue (sans les Ã©liminÃ©s dÃ©finitifs 'e')
    let qualCount = 0;
    for (const s of sorted) {
      const abbr = s.teamAbbrev?.default;
      const hcId = NHL_TO_HC[abbr];
      if (!hcId) continue;
      teamPts[hcId] = s.points || 0;
      confRanks[hcId] = s.conferenceSequence || s.leagueSequence || 99;
      if (s.clinchIndicator !== 'e' && qualCount < 16) {
        qualified.push(hcId);
        qualCount++;
      }
    }

    const notQualified = Object.keys(NHL_TO_HC).filter(id => !qualified.includes(id));

    // 3. Snapshot season_close_price depuis current_prices
    const { data: prices } = await supabase.from('current_prices').select('team_id, price');
    for (const cp of prices || []) {
      await supabase.from('teams')
        .update({ season_close_price: parseFloat(cp.price) })
        .eq('id', cp.team_id).is('season_close_price', null);
    }
    console.log('[AUTO-BASCULEMENT] season_close_price snapshotÃ©');

    // 4. Marquer season_pts + conference_rank
    for (const [id, pts] of Object.entries(teamPts)) {
      await supabase.from('teams')
        .update({ season_pts: pts, conference_rank: confRanks[id] || null })
        .eq('id', id);
    }
    console.log('[AUTO-BASCULEMENT] season_pts + conference_rank mis Ã  jour');

    // 5. Ã‰quipes actives
    if (qualified.length > 0) {
      await supabase.from('teams')
        .update({ playoff_status:'active', playoff_round:1, playoff_locked:false, eliminated_at:null })
        .in('id', qualified);
    }

    // 6. Ã‰quipes non qualifiÃ©es
    if (notQualified.length > 0) {
      await supabase.from('teams')
        .update({ playoff_status:'not_qualified', playoff_locked:true, eliminated_at:now })
        .in('id', notQualified);
    }

    // 7. Bascule season_config
    await supabase.from('season_config')
      .update({ mode:'playoffs', playoff_round:1, playoffs_started_at:now, updated_at:now })
      .eq('id', 1);

    // Recharger la config locale
    await loadSeasonConfig();

    console.log(`[AUTO-BASCULEMENT] âœ… TerminÃ© â€” ${qualified.length} Ã©quipes actives, ${notQualified.length} figÃ©es`);
    console.log('[AUTO-BASCULEMENT] QualifiÃ©es:', qualified.join(', '));

    if (broadcast) {
      broadcast({ type:'PLAYOFFS_STARTED', round:1, qualified, notQualified, timestamp:now });
    }

  } catch (err) {
    console.error('[AUTO-BASCULEMENT] Erreur exÃ©cution:', err.message);
  }
}

// â”€â”€ Avancement automatique de ronde â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * DÃ©tecte automatiquement le passage Ã  la ronde suivante.
 * En mode playoffs, vÃ©rifie si toutes les sÃ©ries de la ronde courante sont terminÃ©es.
 * Utilise l'endpoint playoff/bracket de l'API NHL.
 */
async function checkRondeAvancement(broadcast = null) {
  const round = seasonConfig.playoff_round || 1;
  if (round >= 4) return; // Finale Stanley â€” pas d'avancement possible

  try {
    const BASE = 'https://api-web.nhle.com/v1';
    // VÃ©rifier via les standings si de nouvelles Ã©quipes ont un playoff_round > round courant
    // Ou plus simplement: compter les Ã©quipes encore actives â€” si < 16/8/4/2 selon la ronde
    const expectedActive = { 1:16, 2:8, 3:4, 4:2 };
    const { data: activeTeams } = await supabase.from('teams')
      .select('id').eq('playoff_status','active');

    const currentActive = activeTeams?.length || 0;
    const nextRoundExpected = expectedActive[round + 1];

    if (currentActive === nextRoundExpected) {
      console.log(`[AUTO-RONDE] ðŸ’ ${currentActive} Ã©quipes actives â†’ passage Ã  la ronde ${round + 1}!`);
      const now = new Date().toISOString();
      await supabase.from('season_config')
        .update({ playoff_round: round + 1, updated_at: now })
        .eq('id', 1);
      await supabase.from('teams')
        .update({ playoff_round: round + 1 })
        .eq('playoff_status', 'active');

      // RÃ©initialiser les stats de sÃ©rie
      const { data: active } = await supabase.from('teams').select('id').eq('playoff_status','active');
      for (const t of active || []) {
        await supabase.from('nhl_team_stats')
          .update({ playoff_series_wins:0, playoff_series_losses:0 })
          .eq('team_id', t.id);
      }

      await loadSeasonConfig();
      console.log(`[AUTO-RONDE] âœ… Ronde ${round + 1} dÃ©marrÃ©e â€” ${currentActive} Ã©quipes`);
      if (broadcast) broadcast({ type:'ROUND_ADVANCED', round: round + 1, timestamp: now });
    }
  } catch (err) {
    console.error('[AUTO-RONDE] Erreur:', err.message);
  }
}

// â”€â”€ Dispatcher principal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Point d'entrÃ©e unique â€” toutes les 30 secondes.
 * Tout est automatique : dÃ©tection fin de saison, basculement, avancement de ronde.
 */
async function runJob(broadcast = null) {
  await loadSeasonConfig();

  if (seasonConfig.mode === 'regular') {
    // Mode saison rÃ©guliÃ¨re â€” traitement normal + surveillance fin de saison
    await processScores(broadcast);
    await processStandings(broadcast);
    await checkAutoBasculement(broadcast); // ðŸ” Surveille la fin de saison
  } else {
    // Mode sÃ©ries â€” traitement sÃ©ries + avancement de ronde automatique
    await processPlayoffScores(broadcast);
    await checkRondeAvancement(broadcast); // ðŸ” Surveille les changements de ronde
  }
}

module.exports = { runJob, processScores, processPlayoffScores, processStandings, loadSeasonConfig };
