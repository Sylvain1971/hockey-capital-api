'use strict';
/**
 * Hockey Capital — Détection des événements uniques en séries
 * Appelé par nhlJob.js après chaque match terminé en mode playoffs
 *
 * Événements détectés (one-shot, non répétables par équipe/série):
 *   sweep        — balayage 4-0
 *   comeback_0_3 — remontée depuis 0-3
 *   upset_series_win — surprise gagne la série
 *   eliminated   — 4e défaite (prix figé)
 *   champion     — 4e victoire en finale (Coupe Stanley)
 */

const { supabase } = require('./supabaseService');

/**
 * Vérifie si un événement one-shot a déjà été émis pour cette équipe/série
 * @param {string} teamId
 * @param {string} eventType  — 'sweep' | 'comeback_0_3' | etc.
 * @param {number} round
 */
async function eventAlreadyFired(teamId, eventType, round) {
  const { data } = await supabase
    .from('playoff_events')
    .select('id')
    .eq('team_id', teamId)
    .eq('event_type', eventType)
    .eq('playoff_round', round)
    .limit(1);
  return data && data.length > 0;
}

/**
 * Enregistre un événement dans playoff_events
 */
async function logPlayoffEvent({ teamId, eventType, priceImpact, round, upsetCoeff = null }) {
  await supabase.from('playoff_events').insert({
    team_id:      teamId,
    event_type:   eventType,
    price_impact: priceImpact,
    playoff_round: round,
    upset_coeff:  upsetCoeff,
  });
}

/**
 * Analyse un résultat de série et retourne les événements one-shot à déclencher
 *
 * @param {object} seriesState  — état courant de la série
 *   { teamId, round, seriesWins, seriesLosses, isChampionshipRound,
 *     thisTeam: {season_pts, conference_rank},
 *     opponent: {season_pts, conference_rank},
 *     wasDown03: boolean — équipe était à 0-3 avant cette victoire }
 * @returns {Promise<Array>} liste d'événements: [{ type, upsetCoeff, priceImpact }]
 */
async function detectPlayoffEvents(seriesState) {
  const {
    teamId, round, seriesWins, seriesLosses,
    isChampionshipRound = false,
    thisTeam = {}, opponent = {},
    wasDown03 = false,
  } = seriesState;

  const events = [];
  const { detectUpset } = require('./priceImpact');
  const { coeff, thisFavored } = detectUpset(thisTeam, opponent);
  const isUnderdog = !thisFavored;
  const isFavorite =  thisFavored;

  // ── Victoire de série (4 victoires) ──────────────────────────────────────
  if (seriesWins === 4) {

    // Balayage 4-0
    if (seriesLosses === 0) {
      const alreadyDone = await eventAlreadyFired(teamId, 'sweep', round);
      if (!alreadyDone) {
        events.push({ type: 'sweep', upsetCoeff: null, priceImpact: 8.0 });
      }
    }

    // Remontée 0-3
    if (wasDown03) {
      const alreadyDone = await eventAlreadyFired(teamId, 'comeback_0_3', round);
      if (!alreadyDone) {
        const raw = Math.min(15.0 * coeff, 35.0);
        events.push({ type: 'comeback_0_3', upsetCoeff: coeff, priceImpact: parseFloat(raw.toFixed(2)) });
      }
    }

    // Victoire surprise (underdog gagne la série)
    if (isUnderdog && coeff > 1.0) {
      const alreadyDone = await eventAlreadyFired(teamId, 'upset_series_win', round);
      if (!alreadyDone) {
        const raw = Math.min(10.0 * coeff, 35.0);
        events.push({ type: 'upset_series_win', upsetCoeff: coeff, priceImpact: parseFloat(raw.toFixed(2)), forWinner: true });
      }
    }

    // Champion Coupe Stanley
    if (isChampionshipRound) {
      const alreadyDone = await eventAlreadyFired(teamId, 'champion', round);
      if (!alreadyDone) {
        events.push({ type: 'champion', upsetCoeff: null, priceImpact: 25.0 });
      }
    }
  }

  // ── Élimination (4 défaites) ──────────────────────────────────────────────
  if (seriesLosses === 4) {
    const alreadyDone = await eventAlreadyFired(teamId, 'eliminated', round);
    if (!alreadyDone) {
      events.push({ type: 'eliminated', upsetCoeff: null, priceImpact: -15.0 });
    }
  }

  // ── Malus favori éliminé par surprise ─────────────────────────────────────
  if (seriesLosses === 4 && isFavorite && coeff > 1.0) {
    const alreadyDone = await eventAlreadyFired(teamId, 'upset_series_win', round);
    if (!alreadyDone) {
      const raw = Math.min(8.0 * coeff, 35.0);
      events.push({ type: 'upset_series_win', upsetCoeff: coeff, priceImpact: -parseFloat(raw.toFixed(2)), forWinner: false });
    }
  }

  return events;
}

module.exports = { detectPlayoffEvents, logPlayoffEvent, eventAlreadyFired };
