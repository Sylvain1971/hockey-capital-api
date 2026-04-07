'use strict';
/**
 * Hockey Capital — Service d'impact sur les prix
 * VERSION INITIALE (hypothèses figées — ne pas modifier sans créer une V2)
 *
 * Victoire régulière   : +4.0%
 * Victoire OT/FP       : +2.0%
 * Bonus blanchissage   : +3.0%
 * Défaite régulière    : -3.0%
 * Défaite OT/FP        : -1.0%
 * Streak 3+            : ×1.5
 * Streak 5+            : ×2.0
 * Streak 7+            : ×3.0
 * Rang div. #1         : +1.5%/semaine (+0.2143%/jour)
 * Rang div. #2-3       : +0.5%/semaine (+0.0714%/jour)
 * Rang div. 9+         : -1.0%/semaine (-0.1429%/jour)
 * Dividende victoire   : $0.08/action (×mult streak si 3+)
 * Qualification séries : +12% unique
 * Prix plancher        : $0.50
 */

const ALGO = {
  WIN_REG:          0.04,
  WIN_OT:           0.02,
  SHUTOUT_BONUS:    0.03,
  LOSS_REG:         0.03,
  LOSS_OT:          0.01,
  STREAK_MULT_3:    1.5,
  STREAK_MULT_5:    2.0,
  STREAK_MULT_7:    3.0,
  RANK_1_WEEKLY:    0.015,
  RANK_23_WEEKLY:   0.005,
  RANK_9_WEEKLY:    0.010,
  DIVIDEND_BASE:    0.08,
  CLINCH_BONUS:     0.12,
  PRICE_FLOOR:      0.50,
};

/**
 * Calcule le multiplicateur de streak
 */
function streakMultiplier(streak) {
  if (streak >= 7) return ALGO.STREAK_MULT_7;
  if (streak >= 5) return ALGO.STREAK_MULT_5;
  if (streak >= 3) return ALGO.STREAK_MULT_3;
  return 1.0;
}

/**
 * Calcule l'impact d'un résultat de match sur le prix
 * @param {object} gameResult - résultat du match LNH
 * @param {boolean} gameResult.won - victoire?
 * @param {boolean} gameResult.overtime - prolongation/fusillade?
 * @param {boolean} gameResult.shutout - blanchissage?
 * @param {number}  gameResult.winStreak - streak actuel avant ce match
 * @param {number}  currentPrice - prix courant de l'action
 * @returns {object} { newPrice, pctChange, dividend, breakdown, log }
 */
function applyGameResult(gameResult, currentPrice) {
  const { won, overtime, shutout, winStreak = 0 } = gameResult;
  let totalPct = 0;
  const breakdown = [];

  if (won) {
    const baseWinPct = overtime ? ALGO.WIN_OT : ALGO.WIN_REG;
    const newStreak = winStreak + 1;
    const mult = streakMultiplier(newStreak);
    const effectivePct = baseWinPct * mult;

    totalPct += effectivePct;
    breakdown.push({
      rule: overtime ? 'Victoire OT/FP' : 'Victoire régulière',
      basePct: baseWinPct,
      multiplier: mult,
      effectivePct,
      positive: true,
    });

    if (shutout) {
      totalPct += ALGO.SHUTOUT_BONUS;
      breakdown.push({
        rule: 'Bonus blanchissage',
        basePct: ALGO.SHUTOUT_BONUS,
        multiplier: 1,
        effectivePct: ALGO.SHUTOUT_BONUS,
        positive: true,
      });
    }
  } else {
    const baseLossPct = overtime ? ALGO.LOSS_OT : ALGO.LOSS_REG;
    totalPct -= baseLossPct;
    breakdown.push({
      rule: overtime ? 'Défaite OT/FP' : 'Défaite régulière',
      basePct: baseLossPct,
      multiplier: 1,
      effectivePct: baseLossPct,
      positive: false,
    });
  }

  const newPrice = Math.max(ALGO.PRICE_FLOOR, parseFloat((currentPrice * (1 + totalPct)).toFixed(4)));
  const pctChange = parseFloat(((newPrice - currentPrice) / currentPrice * 100).toFixed(3));

  // Dividende
  const newStreak = won ? winStreak + 1 : 0;
  const divMult = won ? streakMultiplier(newStreak) : 0;
  const dividend = won ? parseFloat((ALGO.DIVIDEND_BASE * divMult).toFixed(4)) : 0;

  return {
    newPrice,
    pctChange,
    dividend,
    breakdown,
    log: {
      trigger: 'game_result',
      description: buildDescription(gameResult, newStreak, pctChange),
      pctChange,
    },
  };
}

/**
 * Ajustement hebdomadaire basé sur le classement de division
 * Typiquement appelé via un cron quotidien (÷7 pour la valeur journalière)
 * @param {number} divisionRank - rang dans la division (1–8+)
 * @param {number} currentPrice
 * @param {boolean} daily - si true, divise par 7 (ajustement quotidien)
 */
function applyStandingsAdjustment(divisionRank, currentPrice, daily = true) {
  const divisor = daily ? 7 : 1;
  let weeklyPct = 0;
  let rule = '';

  if (divisionRank === 1) {
    weeklyPct = ALGO.RANK_1_WEEKLY;
    rule = 'Leader de division #1';
  } else if (divisionRank <= 3) {
    weeklyPct = ALGO.RANK_23_WEEKLY;
    rule = `Rang division #${divisionRank} (zone séries)`;
  } else if (divisionRank >= 9) {
    weeklyPct = -ALGO.RANK_9_WEEKLY;
    rule = `Rang division #${divisionRank} (hors séries)`;
  }

  if (weeklyPct === 0) return { newPrice: currentPrice, pctChange: 0, breakdown: [] };

  const effectivePct = weeklyPct / divisor;
  const newPrice = Math.max(ALGO.PRICE_FLOOR, parseFloat((currentPrice * (1 + effectivePct)).toFixed(4)));
  const pctChange = parseFloat(((newPrice - currentPrice) / currentPrice * 100).toFixed(3));

  return {
    newPrice,
    pctChange,
    breakdown: [{ rule, basePct: weeklyPct, effectivePct, positive: weeklyPct > 0 }],
    log: {
      trigger: 'standings',
      description: `${rule} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`,
      pctChange,
    },
  };
}

/**
 * Bonus unique de qualification aux séries (+12%)
 * Doit être appliqué UNE seule fois par équipe par saison
 */
function applyPlayoffClinch(currentPrice) {
  const newPrice = Math.max(ALGO.PRICE_FLOOR, parseFloat((currentPrice * (1 + ALGO.CLINCH_BONUS)).toFixed(4)));
  const pctChange = parseFloat(((newPrice - currentPrice) / currentPrice * 100).toFixed(3));
  return {
    newPrice,
    pctChange,
    breakdown: [{ rule: 'Qualification séries éliminatoires', basePct: ALGO.CLINCH_BONUS, effectivePct: ALGO.CLINCH_BONUS, positive: true }],
    log: { trigger: 'clinch', description: `Qualification aux séries — bonus unique +${(ALGO.CLINCH_BONUS * 100).toFixed(0)}%`, pctChange },
  };
}

/**
 * Pénalité d'élimination en séries (-20%)
 */
function applyPlayoffElimination(currentPrice) {
  const pct = -0.20;
  const newPrice = Math.max(ALGO.PRICE_FLOOR, parseFloat((currentPrice * (1 + pct)).toFixed(4)));
  const pctChange = parseFloat(((newPrice - currentPrice) / currentPrice * 100).toFixed(3));
  return {
    newPrice,
    pctChange,
    breakdown: [{ rule: 'Élimination en séries', basePct: 0.20, effectivePct: 0.20, positive: false }],
    log: { trigger: 'elimination', description: `Élimination en séries — -20%`, pctChange },
  };
}

function buildDescription(gameResult, newStreak, pctChange) {
  const { won, overtime, shutout } = gameResult;
  let parts = [];
  if (won) {
    parts.push(overtime ? 'Victoire OT/FP' : 'Victoire régulière');
    if (shutout) parts.push('blanchissage');
    if (newStreak >= 3) parts.push(`streak ${newStreak} (×${streakMultiplier(newStreak).toFixed(1)})`);
  } else {
    parts.push(overtime ? 'Défaite OT/FP' : 'Défaite régulière');
  }
  return `${parts.join(' + ')} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`;
}

module.exports = { applyGameResult, applyStandingsAdjustment, applyPlayoffClinch, applyPlayoffElimination, ALGO, streakMultiplier };
