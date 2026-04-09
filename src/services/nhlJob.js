'use strict';
/**
 * Hockey Capital — Job de traitement LNH v2.0
 * Lit season_config.mode au démarrage → choisit la stratégie regular ou playoffs
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

// ── Config globale (chargée au démarrage et rechargée si besoin) ──────────────
let seasonConfig = { mode: 'regular', playoff_round: null };

async function loadSeasonConfig() {
  const { data } = await supabase.from('season_config').select('*').eq('id', 1).single();
  if (data) seasonConfig = data;
  return seasonConfig;
}

// ── Helpers partagés ─────────────────────────────────────────────────────────

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

// ── SAISON RÉGULIÈRE ─────────────────────────────────────────────────────────

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
    console.log(`[PRIX] ${teamId}: $${currentPrice} → $${impact.newPrice} (${impact.pctChange >= 0 ? '+' : ''}${impact.pctChange}%)`);
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

// ── SÉRIES ÉLIMINATOIRES ─────────────────────────────────────────────────────

/**
 * Job principal séries — remplace processScores() quand mode = 'playoffs'
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

      // Vérifier que l'équipe est encore active en séries
      const { data: teamData } = await supabase
        .from('teams').select('playoff_status, playoff_locked, season_pts, conference_rank')
        .eq('id', result.teamId).single();

      if (!teamData || teamData.playoff_status !== 'active' || teamData.playoff_locked) {
        console.log(`[PLAYOFFS] ${result.teamId} ignoré (statut: ${teamData?.playoff_status})`);
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

    // Trouver les données de l'adversaire pour le calcul d'upset
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

    // Récupérer état série courant depuis les stats
    const stats = await getNHLStats(teamId);
    const seriesWins   = (stats.playoff_series_wins   || 0) + (won ? 1 : 0);
    const seriesLosses = (stats.playoff_series_losses || 0) + (won ? 0 : 1);
    const wasDown03 = !won ? false : (stats.playoff_series_wins === 0 && stats.playoff_series_losses === 3);
    const isChampionshipRound = round === 4;

    await updateNHLStats(teamId, { playoff_series_wins: seriesWins, playoff_series_losses: seriesLosses });

    // Détecter et appliquer les événements one-shot
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

      // Figer le marché si élimination ou champion
      if (event.type === 'eliminated' || event.type === 'champion') {
        await supabase.from('teams').update({
          playoff_locked: true,
          playoff_status: event.type === 'champion' ? 'champion' : 'eliminated',
          eliminated_at: new Date().toISOString(),
        }).eq('id', teamId);
        console.log(`[PLAYOFFS] ${teamId} ${event.type === 'champion' ? '🏆 Champion!' : 'éliminé'} — marché figé`);
      }

      if (broadcast) broadcast({ type: event.type.toUpperCase(), teamId, newPrice: latestPrice, pctChange: eventImpact.pctChange, round });
    }

    if (broadcast) broadcast({ type: 'PRICE_UPDATE', teamId, newPrice: latestPrice, pctChange: impact.pctChange, reason: impact.log.description });
    console.log(`[PLAYOFFS R${round}] ${teamId}: $${currentPrice} → $${latestPrice} (${impact.pctChange >= 0 ? '+' : ''}${impact.pctChange}%)`);

  } catch (err) { console.error(`[PLAYOFFS] Erreur ${teamId}:`, err.message); }
}

// ── Dispatcher principal ─────────────────────────────────────────────────────

/**
 * Point d'entrée unique appelé par le scheduler (toutes les 30s)
 * Choisit automatiquement la bonne stratégie selon season_config
 */
async function runJob(broadcast = null) {
  await loadSeasonConfig();
  if (seasonConfig.mode === 'playoffs') {
    await processPlayoffScores(broadcast);
  } else {
    await processScores(broadcast);
    await processStandings(broadcast);
  }
}

module.exports = { runJob, processScores, processPlayoffScores, processStandings, loadSeasonConfig };
