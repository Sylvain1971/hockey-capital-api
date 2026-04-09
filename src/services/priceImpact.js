'use strict';
/**
 * Hockey Capital — Service d'impact sur les prix v2.0
 * Deux stratégies interchangeables selon season_config.mode:
 *   regular()  — saison régulière (logique originale)
 *   playoffs() — séries éliminatoires (nouveau)
 */

// ── Constantes saison régulière ──────────────────────────────────────────────
const REGULAR = {
  WIN_REG:        0.04,
  WIN_OT:         0.02,
  SHUTOUT_BONUS:  0.03,
  LOSS_REG:       0.03,
  LOSS_OT:        0.01,
  STREAK_MULT_3:  1.5,
  STREAK_MULT_5:  2.0,
  STREAK_MULT_7:  3.0,
  RANK_1_WEEKLY:  0.015,
  RANK_23_WEEKLY: 0.005,
  RANK_9_WEEKLY:  0.010,
  DIVIDEND_BASE:  0.08,
  CLINCH_BONUS:   0.12,
  ELIM_PENALTY:   0.15,
  PRICE_FLOOR:    0.50,
};

// ── Constantes séries éliminatoires ──────────────────────────────────────────
const PLAYOFFS = {
  WIN_BASE:       0.05,
  WIN_OT_BONUS:   0.03,   // s'ajoute à WIN_BASE → +8% total en OT
  LOSS_BASE:      0.04,   // défaite régulière ET OT = -4%
  ROUND_MULT:     { 1: 1.0, 2: 1.3, 3: 1.6, 4: 2.0 },
  SWEEP_BONUS:    0.08,   // +8% one-shot balayage 4-0
  COMEBACK_BONUS: 0.15,   // +15% one-shot remontée 0-3
  ELIM_PENALTY:   0.15,   // -15% élimination (unifié avec saison)
  CHAMPION_BONUS: 0.25,   // +25% terminal Coupe Stanley
  UPSET_WIN_BASE: 0.10,   // +10% × upsetCoeff si surprise gagne la série
  UPSET_LOSS_BASE:0.08,   // -8%  × upsetCoeff si favorite perd la série
  CAP:            0.35,   // plafond ±35% par match toutes composantes
  PRICE_FLOOR:    0.50,
};

// ── Helpers partagés ─────────────────────────────────────────────────────────

function streakMultiplier(streak) {
  if (streak >= 7) return REGULAR.STREAK_MULT_7;
  if (streak >= 5) return REGULAR.STREAK_MULT_5;
  if (streak >= 3) return REGULAR.STREAK_MULT_3;
  return 1.0;
}

function applyFloor(price) {
  return Math.max(REGULAR.PRICE_FLOOR, parseFloat(price.toFixed(4)));
}

function pct(newPrice, oldPrice) {
  return parseFloat(((newPrice - oldPrice) / oldPrice * 100).toFixed(3));
}

/**
 * Calcule le coefficient d'upset (1.0 → 1.50)
 * @param {object} favorite  { season_pts, conference_rank }
 * @param {object} underdog  { season_pts, conference_rank }
 */
function upsetCoefficient(favorite, underdog) {
  if (!favorite || !underdog) return 1.0;
  const ecartPts  = Math.max(0, (favorite.season_pts  - underdog.season_pts))  / 82;
  const ecartRang = Math.max(0, (underdog.conference_rank - favorite.conference_rank)) / 15;
  const ecartComb = (ecartPts + ecartRang) / 2;
  return parseFloat(Math.min(1.0 + ecartComb * 0.5, 1.50).toFixed(3));
}

/**
 * Détermine si une équipe est la surprise (underdog) dans un matchup
 * @param {object} thisTeam   { season_pts, conference_rank }
 * @param {object} opponent   { season_pts, conference_rank }
 * @returns {{ isUpset: bool, coeff: number, favorite: obj, underdog: obj }}
 */
function detectUpset(thisTeam, opponent) {
  const thisFavored = (thisTeam.season_pts > opponent.season_pts) ||
    (thisTeam.season_pts === opponent.season_pts &&
     thisTeam.conference_rank < opponent.conference_rank);

  const favorite = thisFavored ? thisTeam : opponent;
  const underdog  = thisFavored ? opponent : thisTeam;
  const coeff = upsetCoefficient(favorite, underdog);
  return { thisFavored, coeff, favorite, underdog };
}

// ── STRATÉGIE SAISON RÉGULIÈRE ────────────────────────────────────────────────

/**
 * Impact d'un résultat de match — saison régulière
 * API identique à l'original pour compatibilité avec nhlJob.js existant
 */
function applyGameResult(gameResult, currentPrice) {
  const { won, overtime, shutout, winStreak = 0 } = gameResult;
  let totalPct = 0;
  const breakdown = [];

  if (won) {
    const baseWinPct = overtime ? REGULAR.WIN_OT : REGULAR.WIN_REG;
    const newStreak  = winStreak + 1;
    const mult       = streakMultiplier(newStreak);
    const effectivePct = baseWinPct * mult;
    totalPct += effectivePct;
    breakdown.push({ rule: overtime ? 'Victoire OT/FP' : 'Victoire régulière', basePct: baseWinPct, multiplier: mult, effectivePct, positive: true });

    if (shutout) {
      totalPct += REGULAR.SHUTOUT_BONUS;
      breakdown.push({ rule: 'Bonus blanchissage', basePct: REGULAR.SHUTOUT_BONUS, multiplier: 1, effectivePct: REGULAR.SHUTOUT_BONUS, positive: true });
    }
  } else {
    const baseLossPct = overtime ? REGULAR.LOSS_OT : REGULAR.LOSS_REG;
    totalPct -= baseLossPct;
    breakdown.push({ rule: overtime ? 'Défaite OT/FP' : 'Défaite régulière', basePct: baseLossPct, multiplier: 1, effectivePct: baseLossPct, positive: false });
  }

  const newPrice  = applyFloor(currentPrice * (1 + totalPct));
  const pctChange = pct(newPrice, currentPrice);
  const newStreak = won ? winStreak + 1 : 0;
  const divMult   = won ? streakMultiplier(newStreak) : 0;
  const dividend  = won ? parseFloat((REGULAR.DIVIDEND_BASE * divMult).toFixed(4)) : 0;

  return {
    newPrice, pctChange, dividend, breakdown,
    log: { trigger: 'game_result', description: _descRegular(gameResult, newStreak, pctChange), pctChange },
  };
}

function _descRegular(g, newStreak, pctChange) {
  const parts = [];
  if (g.won) {
    parts.push(g.overtime ? 'Victoire OT/FP' : 'Victoire régulière');
    if (g.shutout) parts.push('blanchissage');
    if (newStreak >= 3) parts.push(`streak ${newStreak} (×${streakMultiplier(newStreak).toFixed(1)})`);
  } else {
    parts.push(g.overtime ? 'Défaite OT/FP' : 'Défaite régulière');
  }
  return `${parts.join(' + ')} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`;
}

function applyStandingsAdjustment(divisionRank, currentPrice, daily = true) {
  const divisor = daily ? 7 : 1;
  let weeklyPct = 0, rule = '';
  if (divisionRank === 1)      { weeklyPct = REGULAR.RANK_1_WEEKLY;   rule = 'Leader de division #1'; }
  else if (divisionRank <= 3)  { weeklyPct = REGULAR.RANK_23_WEEKLY;  rule = `Rang division #${divisionRank} (zone séries)`; }
  else if (divisionRank >= 9)  { weeklyPct = -REGULAR.RANK_9_WEEKLY;  rule = `Rang division #${divisionRank} (hors séries)`; }
  if (weeklyPct === 0) return { newPrice: currentPrice, pctChange: 0, breakdown: [] };
  const effectivePct = weeklyPct / divisor;
  const newPrice  = applyFloor(currentPrice * (1 + effectivePct));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule, basePct: weeklyPct, effectivePct, positive: weeklyPct > 0 }],
    log: { trigger: 'standings', description: `${rule} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`, pctChange },
  };
}

function applyPlayoffClinch(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 + REGULAR.CLINCH_BONUS));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule: 'Qualification séries', basePct: REGULAR.CLINCH_BONUS, effectivePct: REGULAR.CLINCH_BONUS, positive: true }],
    log: { trigger: 'clinch', description: `Qualification aux séries — +${(REGULAR.CLINCH_BONUS * 100).toFixed(0)}%`, pctChange },
  };
}

function applyElimination(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 - REGULAR.ELIM_PENALTY));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule: 'Élimination', basePct: REGULAR.ELIM_PENALTY, effectivePct: REGULAR.ELIM_PENALTY, positive: false }],
    log: { trigger: 'elimination', description: `Élimination — -${(REGULAR.ELIM_PENALTY * 100).toFixed(0)}%`, pctChange },
  };
}

// ── STRATÉGIE SÉRIES ÉLIMINATOIRES ───────────────────────────────────────────

/**
 * Impact d'un résultat de match — séries éliminatoires
 * @param {object} gameResult
 *   { won, overtime, round, thisTeam: {season_pts, conference_rank},
 *     opponent: {season_pts, conference_rank} }
 * @param {number} currentPrice
 * @returns {object} { newPrice, pctChange, breakdown, log }
 */
function applyPlayoffGameResult(gameResult, currentPrice) {
  const { won, overtime, round = 1, thisTeam, opponent } = gameResult;
  const breakdown = [];

  // 1. Variation de base
  let basePct = won
    ? PLAYOFFS.WIN_BASE + (overtime ? PLAYOFFS.WIN_OT_BONUS : 0)
    : -PLAYOFFS.LOSS_BASE;

  breakdown.push({
    rule: won ? (overtime ? 'Victoire OT séries' : 'Victoire séries') : 'Défaite séries',
    basePct: Math.abs(basePct),
    positive: won,
  });

  // 2. Multiplicateur de ronde
  const roundMult = PLAYOFFS.ROUND_MULT[round] || 1.0;
  let totalPct = basePct * roundMult;

  if (roundMult !== 1.0) {
    breakdown.push({ rule: `Ronde ${round} (×${roundMult})`, basePct: roundMult, multiplier: true });
  }

  // 3. Upset coefficient — appliqué si la surprise gagne
  const { thisFavored, coeff } = detectUpset(thisTeam || {}, opponent || {});
  const isUpset = won && !thisFavored && coeff > 1.0;
  const isUpsetLoss = !won && thisFavored && coeff > 1.0;

  if (isUpset || isUpsetLoss) {
    totalPct = totalPct * coeff;
    breakdown.push({ rule: `Upset ×${coeff}`, coeff, positive: isUpset });
  }

  // 4. Plafond ±35%
  const capped = totalPct > 0
    ? Math.min(totalPct, PLAYOFFS.CAP)
    : Math.max(totalPct, -PLAYOFFS.CAP);

  if (Math.abs(capped) < Math.abs(totalPct)) {
    breakdown.push({ rule: `Plafond ±${PLAYOFFS.CAP * 100}%`, capped: true });
  }

  const newPrice  = applyFloor(currentPrice * (1 + capped));
  const pctChange = pct(newPrice, currentPrice);

  return {
    newPrice, pctChange, breakdown,
    upsetCoeff: (isUpset || isUpsetLoss) ? coeff : null,
    log: {
      trigger: 'playoff_game',
      description: `R${round} ${won ? 'Victoire' : 'Défaite'}${overtime ? ' OT' : ''}${isUpset ? ` (upset ×${coeff})` : ''} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`,
      pctChange,
      round,
    },
  };
}

/**
 * Bonus one-shot balayage 4-0 (+8%)
 */
function applyPlayoffSweep(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 + PLAYOFFS.SWEEP_BONUS));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule: 'Balayage 4-0', basePct: PLAYOFFS.SWEEP_BONUS, positive: true }],
    log: { trigger: 'sweep', description: `Balayage 4-0 — +${(PLAYOFFS.SWEEP_BONUS * 100).toFixed(0)}%`, pctChange },
  };
}

/**
 * Bonus one-shot remontée 0-3 (+15% × upsetCoeff)
 */
function applyPlayoffComeback(currentPrice, upsetCoeff = 1.0) {
  const raw = Math.min(PLAYOFFS.COMEBACK_BONUS * upsetCoeff, PLAYOFFS.CAP);
  const newPrice  = applyFloor(currentPrice * (1 + raw));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule: `Remontée 0-3${upsetCoeff > 1 ? ` ×${upsetCoeff}` : ''}`, basePct: raw, positive: true }],
    log: { trigger: 'comeback_0_3', description: `Remontée 0-3 — +${(raw * 100).toFixed(1)}%`, pctChange },
  };
}

/**
 * Bonus one-shot victoire de série en tant que surprise (+10% × upsetCoeff)
 * et malus symétrique pour la favorite (-8% × upsetCoeff)
 */
function applyUpsetseries(currentPrice, upsetCoeff = 1.0, isWinner = true) {
  const base = isWinner ? PLAYOFFS.UPSET_WIN_BASE : -PLAYOFFS.UPSET_LOSS_BASE;
  const raw  = Math.min(Math.abs(base * upsetCoeff), PLAYOFFS.CAP) * Math.sign(base);
  const newPrice  = applyFloor(currentPrice * (1 + raw));
  const pctChange = pct(newPrice, currentPrice);
  const label = isWinner ? `Victoire upset série ×${upsetCoeff}` : `Défaite surprise série ×${upsetCoeff}`;
  return {
    newPrice, pctChange,
    breakdown: [{ rule: label, basePct: Math.abs(raw), positive: isWinner }],
    log: { trigger: 'upset_series_win', description: `${label} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`, pctChange },
  };
}

/**
 * Bonus terminal Champion Coupe Stanley (+25%)
 */
function applyChampion(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 + PLAYOFFS.CHAMPION_BONUS));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule: 'Champion Coupe Stanley', basePct: PLAYOFFS.CHAMPION_BONUS, positive: true }],
    log: { trigger: 'champion', description: `🏆 Champion Coupe Stanley — +${(PLAYOFFS.CHAMPION_BONUS * 100).toFixed(0)}%`, pctChange },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Saison régulière (API identique à v1 — compatibilité totale)
  applyGameResult,
  applyStandingsAdjustment,
  applyPlayoffClinch,
  applyElimination,
  streakMultiplier,
  ALGO: REGULAR,
  // Séries (nouveau)
  applyPlayoffGameResult,
  applyPlayoffSweep,
  applyPlayoffComeback,
  applyUpsetseries,
  applyChampion,
  upsetCoefficient,
  detectUpset,
  REGULAR,
  PLAYOFFS,
};
