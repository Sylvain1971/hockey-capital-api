'use strict';
/**
 * Hockey Capital — Job de traitement LNH
 * S'exécute toutes les 30 secondes via setInterval ou un cron externe.
 * Séquence: fetch LNH → appliquer impact VERSION INITIALE → MAJ DB → broadcast WebSocket
 */

const { fetchScores, fetchStandings } = require('./nhlApi');
const { applyGameResult, applyStandingsAdjustment, applyPlayoffClinch } = require('./priceImpact');
const {
  getCurrentPrice, updatePrice, logPriceImpact,
  getNHLStats, updateNHLStats, markClinchBonusPaid,
  payDividend, supabase,
} = require('./supabaseService');

const processedGames = new Set(); // cache mémoire session

/**
 * Vérifie si un match a déjà été traité (en DB)
 */
async function isGameProcessed(gameId) {
  if (processedGames.has(gameId)) return true;
  const { data } = await supabase
    .from('price_impact_log')
    .select('id')
    .eq('trigger', 'game_result')
    .like('description', `%[${gameId}]%`)
    .limit(1);
  return data && data.length > 0;
}

/**
 * Job principal: traite les scores du jour
 */
async function processScores(broadcast = null) {
  let games;
  try {
    games = await fetchScores();
  } catch (err) {
    console.error('[NHL] Erreur fetch scores:', err.message);
    return;
  }

  let processedAny = false;

  for (const game of games) {
    if (!game.isFinal) continue;
    if (processedGames.has(game.gameId)) continue;
    if (await isGameProcessed(game.gameId)) {
      processedGames.add(game.gameId);
      continue;
    }

    // Snapshot AVANT l'impact pour chaque equipe (prix d'ouverture = prix avant le match)
    for (const result of [game.homeResult, game.awayResult]) {
      if (!result?.teamId) continue;
      try {
        const { data: cp } = await supabase.from('current_prices').select('price').eq('team_id', result.teamId).single();
        if (cp) await snapshotOpenPrice(result.teamId, parseFloat(cp.price));
      } catch(e) {}
    }

    processedGames.add(game.gameId);
    processedAny = true;

    for (const result of [game.homeResult, game.awayResult]) {
      if (!result || !result.teamId) continue;
      await processTeamGameResult(result, game.gameId, broadcast);
    }
  }
  return processedAny;
}

/**
 * Enregistre le prix d'ouverture du jour si pas encore fait
 * Permet de calculer la vraie variation journalière
 */
async function snapshotOpenPrice(teamId, currentPrice) {
  const today = new Date().toISOString().split('T')[0]; // date UTC ex: "2026-04-09"

  // Insérer le prix d'ouverture du jour si pas encore fait
  const { data } = await supabase
    .from('daily_open_prices')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('date', today)
    .limit(1);

  if (!data || data.length === 0) {
    await supabase.from('daily_open_prices').insert({
      team_id: teamId,
      price: currentPrice,
      date: today,
    });
  }
}

/**
 * Applique l'impact d'un résultat sur une équipe
 */
async function processTeamGameResult(result, gameId, broadcast) {
  const { teamId, won, overtime, shutout } = result;

  try {
    const stats = await getNHLStats(teamId);
    const currentPrice = await getCurrentPrice(teamId);

    // Calcul du nouveau streak
    const currentStreak = stats.win_streak || 0;
    const winStreak = won
      ? Math.max(0, currentStreak) + 1
      : 0;
    const lossStreak = won
      ? 0
      : Math.min(0, currentStreak) - 1;
    const newStreak = won ? winStreak : lossStreak;

    // Appliquer l'impact VERSION INITIALE
    const impact = applyGameResult(
      { won, overtime, shutout, winStreak: Math.max(0, currentStreak) },
      currentPrice
    );

    // Sauvegarder le nouveau prix global
    await updatePrice(teamId, impact.newPrice);
    await logPriceImpact(teamId, impact.log.trigger, `${impact.log.description} [${gameId}]`, currentPrice, impact.newPrice);

    // Propager le prix dans toutes les ligues actives
    await propagatePriceToLeagues(teamId, impact.newPrice, impact.pctChange);

    // Mettre à jour les stats LNH
    const statUpdate = {
      win_streak: newStreak,
      last_game_result: won ? (overtime ? 'OTW' : 'W') : (overtime ? 'OTL' : 'L'),
      last_game_was_shutout: shutout,
    };
    if (won) {
      statUpdate.wins = (stats.wins || 0) + 1;
      statUpdate.games_played = (stats.games_played || 0) + 1;
    } else {
      if (overtime) statUpdate.ot_losses = (stats.ot_losses || 0) + 1;
      else statUpdate.losses = (stats.losses || 0) + 1;
      statUpdate.games_played = (stats.games_played || 0) + 1;
    }
    await updateNHLStats(teamId, statUpdate);

    // Verser le dividende si victoire
    if (won && impact.dividend > 0) {
      try {
        const divResult = await payDividend({
          teamId,
          amountPerShare: impact.dividend,
          reason: impact.log.description,
          gameId,
          streakAtTime: winStreak,
          multiplier: winStreak >= 7 ? 3.0 : winStreak >= 5 ? 2.0 : winStreak >= 3 ? 1.5 : 1.0,
        });
        console.log(`[DIV] ${teamId}: $${impact.dividend}/action → ${divResult.holders} actionnaires, total $${divResult.paid.toFixed(2)}`);
      } catch (e) {
        console.error(`[DIV] Erreur paiement ${teamId}:`, e.message);
      }
    }

    // Broadcast WebSocket
    if (broadcast) {
      broadcast({
        type: 'PRICE_UPDATE',
        teamId,
        newPrice: impact.newPrice,
        pctChange: impact.pctChange,
        reason: impact.log.description,
        dividend: impact.dividend,
      });
    }

    console.log(`[PRIX] ${teamId}: $${currentPrice} → $${impact.newPrice} (${impact.pctChange >= 0 ? '+' : ''}${impact.pctChange}%)`);

  } catch (err) {
    console.error(`[GAME] Erreur traitement ${teamId}:`, err.message);
  }
}

/**
 * Job de classement — à exécuter quotidiennement (cron 06:00)
 */
async function processStandings(broadcast = null) {
  let standings;
  try {
    standings = await fetchStandings();
  } catch (err) {
    console.error('[NHL] Erreur fetch standings:', err.message);
    return;
  }

  for (const team of standings) {
    if (!team.teamId) continue;
    try {
      const currentPrice = await getCurrentPrice(team.teamId);
      // Snapshot classement seulement si pas encore fait aujourd'hui (matchs ont priorité)
      await snapshotOpenPrice(team.teamId, currentPrice);

      // Ajustement de classement (quotidien = hebdo ÷ 7)
      const adj = applyStandingsAdjustment(team.divisionRank, currentPrice, true);
      if (adj.pctChange !== 0) {
        await updatePrice(team.teamId, adj.newPrice);
        await logPriceImpact(team.teamId, adj.log.trigger, adj.log.description, currentPrice, adj.newPrice);
        await propagatePriceToLeagues(team.teamId, adj.newPrice, adj.pctChange);
      }

      // Mise à jour des stats standings
      await updateNHLStats(team.teamId, {
        wins: team.wins,
        losses: team.losses,
        ot_losses: team.otLosses,
        points: team.points,
        games_played: team.gamesPlayed,
        division_rank: team.divisionRank,
        goals_for: team.goalsFor,
        goals_against: team.goalsAgainst,
        clinched: team.clinched,
      });

      // Bonus qualification séries (unique)
      const stats = await getNHLStats(team.teamId);
      if (team.clinched && !stats.clinch_bonus_paid) {
        const clinchImpact = applyPlayoffClinch(currentPrice);
        await updatePrice(team.teamId, clinchImpact.newPrice);
        await logPriceImpact(team.teamId, 'clinch', clinchImpact.log.description, currentPrice, clinchImpact.newPrice);
        await markClinchBonusPaid(team.teamId);
        if (broadcast) {
          broadcast({ type: 'CLINCH', teamId: team.teamId, newPrice: clinchImpact.newPrice, pctChange: clinchImpact.pctChange });
        }
        console.log(`[CLINCH] ${team.teamId} qualifié! +${(clinchImpact.pctChange).toFixed(2)}%`);
      }

      if (broadcast && adj.pctChange !== 0) {
        broadcast({ type: 'PRICE_UPDATE', teamId: team.teamId, newPrice: adj.newPrice, pctChange: adj.pctChange, reason: adj.log.description });
      }

    } catch (err) {
      console.error(`[STANDINGS] Erreur ${team.teamId}:`, err.message);
    }
  }
}

/**
 * Propage un nouveau prix dans toutes les ligues actives
 * Insère aussi dans price_impact_log de chaque ligue
 */
async function propagatePriceToLeagues(teamId, newPrice, pctChange) {
  try {
    const { data: leagues } = await supabase
      .from('leagues')
      .select('id')
      .eq('status', 'open');

    if (!leagues || leagues.length === 0) return;

    for (const league of leagues) {
      await supabase
        .from('league_team_prices')
        .update({ price: newPrice })
        .eq('league_id', league.id)
        .eq('team_id', teamId);

      // Log dans l'impact log de la ligue
      if (pctChange !== 0) {
        await supabase.from('league_price_impacts').insert({
          league_id: league.id,
          team_id: teamId,
          pct_change: pctChange,
          description: `Impact LNH: ${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(3)}%`,
        }).select();
      }
    }
  } catch (e) {
    console.error('[LEAGUES] Erreur propagation prix:', e.message);
  }
}

module.exports = { processScores, processStandings };
