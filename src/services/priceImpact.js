'use strict';
/**
 * Hockey Capital — Service d'impact sur les prix v2.1
 * Deux stratégies interchangeables selon season_config.mode:
 *   regular()  — saison régulière (symétrique v2.1)
 *   playoffs() — séries éliminatoires
 *
 * SYMÉTRIE v2.1 (Option C validée):
 *   Victoire régulière +3% / Défaite régulière -3%  → somme = 0 par match ✓
 *   Victoire OT        +1.5% / Défaite OT     -1.5% → somme = 0 par match ✓
 *   Blanchissage +3% bonus conservé (récompense le gardien)
 *   Streak multiplier appliqué aux victoires ET aux séries de défaites
 */

// ── Constantes saison régulière ──────────────────────────────────────────────
const REGULAR = {
  WIN_REG:        0.03,   // était 0.04 → symétrisé avec LOSS_REG
  WIN_OT:         0.015,  // était 0.02 → symétrisé avec LOSS_OT
  SHUTOUT_BONUS:  0.03,   // conservé — récompense spécifique gardien
  LOSS_REG:       0.03,   // inchangé
  LOSS_OT:        0.015,  // était 0.01 → symétrisé avec WIN_OT
  STREAK_MULT_3:  1.5,    // s'applique victoires ET défaites consécutives
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
  WIN_BASE:        0.05,
  WIN_OT_BONUS:    0.03,
  LOSS_BASE:       0.04,
  ROUND_MULT:      { 1: 1.0, 2: 1.3, 3: 1.6, 4: 2.0 },
  SWEEP_BONUS:     0.08,
  COMEBACK_BONUS:  0.15,
  ELIM_PENALTY:    0.15,
  CHAMPION_BONUS:  0.25,
  UPSET_WIN_BASE:  0.10,
  UPSET_LOSS_BASE: 0.08,
  CAP:             0.35,
  PRICE_FLOOR:     0.50,
};

// ── Helpers partagés ─────────────────────────────────────────────────────────

/**
 * Multiplicateur de streak — s'applique aux victoires ET aux défaites consécutives
 * @param {number} streak — positif = victoires consécutives, négatif = défaites consécutives
 */
function streakMultiplier(streak) {
  const abs = Math.abs(streak);
  if (abs >= 7) return REGULAR.STREAK_MULT_7;
  if (abs >= 5) return REGULAR.STREAK_MULT_5;
  if (abs >= 3) return REGULAR.STREAK_MULT_3;
  return 1.0;
}

function applyFloor(price) {
  return Math.max(REGULAR.PRICE_FLOOR, parseFloat(price.toFixed(4)));
}

function pct(newPrice, oldPrice) {
  return parseFloat(((newPrice - oldPrice) / oldPrice * 100).toFixed(3));
}

function upsetCoefficient(favorite, underdog) {
  if (!favorite || !underdog) return 1.0;
  const ecartPts  = Math.max(0, (favorite.season_pts  - underdog.season_pts))  / 82;
  const ecartRang = Math.max(0, (underdog.conference_rank - favorite.conference_rank)) / 15;
  const ecartComb = (ecartPts + ecartRang) / 2;
  return parseFloat(Math.min(1.0 + ecartComb * 0.5, 1.50).toFixed(3));
}

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
 * Impact d'un résultat de match — saison régulière v2.1 (symétrique)
 *
 * Symétrie garantie par match :
 *   Victoire +3% × mult_streak_victoire
 *   Défaite  -3% × mult_streak_defaite
 *   → somme nette = 0 (avant blanchissage)
 *
 * Le streak multiplier amplifie maintenant les deux directions :
 *   3+ victoires consécutives → ×1.5 sur la victoire
 *   3+ défaites consécutives  → ×1.5 sur la défaite (punition accrue)
 *
 * @param {object} gameResult
 *   { won, overtime, shutout, winStreak }
 *   winStreak: positif = streak de victoires, négatif = streak de défaites
 */
function applyGameResult(gameResult, currentPrice) {
  const { won, overtime, shutout, winStreak = 0 } = gameResult;
  let totalPct = 0;
  const breakdown = [];

  if (won) {
    const baseWinPct = overtime ? REGULAR.WIN_OT : REGULAR.WIN_REG;
    const newStreak  = winStreak >= 0 ? winStreak + 1 : 1; // repart à 1 si sortait de streak négatif
    const mult       = streakMultiplier(newStreak);
    const effectivePct = baseWinPct * mult;
    totalPct += effectivePct;
    breakdown.push({
      rule: overtime ? 'Victoire OT/FP' : 'Victoire régulière',
      basePct: baseWinPct, multiplier: mult, effectivePct, positive: true,
    });
    if (shutout) {
      totalPct += REGULAR.SHUTOUT_BONUS;
      breakdown.push({ rule: 'Bonus blanchissage', basePct: REGULAR.SHUTOUT_BONUS, multiplier: 1, effectivePct: REGULAR.SHUTOUT_BONUS, positive: true });
    }
  } else {
    const baseLossPct = overtime ? REGULAR.LOSS_OT : REGULAR.LOSS_REG;
    // Streak de défaites : winStreak négatif → amplifie la punition
    const lossStreak  = winStreak <= 0 ? Math.abs(winStreak) + 1 : 1;
    const mult        = streakMultiplier(lossStreak);
    const effectivePct = baseLossPct * mult;
    totalPct -= effectivePct;
    breakdown.push({
      rule: overtime ? 'Défaite OT/FP' : 'Défaite régulière',
      basePct: baseLossPct, multiplier: mult, effectivePct, positive: false,
    });
  }

  const newPrice  = applyFloor(currentPrice * (1 + totalPct));
  const pctChange = pct(newPrice, currentPrice);

  // Streak mis à jour pour le log
  const newStreak = won
    ? (winStreak >= 0 ? winStreak + 1 : 1)
    : (winStreak <= 0 ? winStreak - 1 : -1);

  // Dividende uniquement sur les victoires (streak positif)
  const divMult  = won ? streakMultiplier(Math.max(1, newStreak)) : 0;
  const dividend = won ? parseFloat((REGULAR.DIVIDEND_BASE * divMult).toFixed(4)) : 0;

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
    if (newStreak >= 3) parts.push(`streak ${newStreak} (x${streakMultiplier(newStreak).toFixed(1)})`);
  } else {
    parts.push(g.overtime ? 'Defaite OT/FP' : 'Defaite reguliere');
    if (Math.abs(newStreak) >= 3) parts.push(`serie noire ${Math.abs(newStreak)} (x${streakMultiplier(Math.abs(newStreak)).toFixed(1)})`);
  }
  return `${parts.join(' + ')} — ${pctChange >= 0 ? '+' : ''}${pctChange}%`;
}

function applyStandingsAdjustment(divisionRank, currentPrice, daily = true) {
  const divisor = daily ? 7 : 1;
  let weeklyPct = 0, rule = '';
  if (divisionRank === 1)     { weeklyPct = REGULAR.RANK_1_WEEKLY;   rule = 'Leader de division #1'; }
  else if (divisionRank <= 3) { weeklyPct = REGULAR.RANK_23_WEEKLY;  rule = `Rang division #${divisionRank} (zone series)`; }
  else if (divisionRank >= 9) { weeklyPct = -REGULAR.RANK_9_WEEKLY;  rule = `Rang division #${divisionRank} (hors series)`; }
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
    breakdown: [{ rule: 'Qualification series', basePct: REGULAR.CLINCH_BONUS, effectivePct: REGULAR.CLINCH_BONUS, positive: true }],
    log: { trigger: 'clinch', description: `Qualification aux series — +${(REGULAR.CLINCH_BONUS*100).toFixed(0)}%`, pctChange },
  };
}

function applyElimination(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 - REGULAR.ELIM_PENALTY));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange,
    breakdown: [{ rule: 'Elimination', basePct: REGULAR.ELIM_PENALTY, effectivePct: REGULAR.ELIM_PENALTY, positive: false }],
    log: { trigger: 'elimination', description: `Elimination — -${(REGULAR.ELIM_PENALTY*100).toFixed(0)}%`, pctChange },
  };
}

// ── STRATÉGIE SÉRIES ÉLIMINATOIRES ───────────────────────────────────────────

function applyPlayoffGameResult(gameResult, currentPrice) {
  const { won, overtime, round = 1, thisTeam, opponent } = gameResult;
  const breakdown = [];
  let basePct = won
    ? PLAYOFFS.WIN_BASE + (overtime ? PLAYOFFS.WIN_OT_BONUS : 0)
    : -PLAYOFFS.LOSS_BASE;
  breakdown.push({ rule: won ? (overtime ? 'Victoire OT series' : 'Victoire series') : 'Defaite series', basePct: Math.abs(basePct), positive: won });
  const roundMult = PLAYOFFS.ROUND_MULT[round] || 1.0;
  let totalPct = basePct * roundMult;
  if (roundMult !== 1.0) breakdown.push({ rule: `Ronde ${round} (x${roundMult})`, basePct: roundMult, multiplier: true });
  const { thisFavored, coeff } = detectUpset(thisTeam || {}, opponent || {});
  const isUpset     = won && !thisFavored && coeff > 1.0;
  const isUpsetLoss = !won && thisFavored && coeff > 1.0;
  if (isUpset || isUpsetLoss) {
    totalPct = totalPct * coeff;
    breakdown.push({ rule: `Upset x${coeff}`, coeff, positive: isUpset });
  }
  const capped = totalPct > 0 ? Math.min(totalPct, PLAYOFFS.CAP) : Math.max(totalPct, -PLAYOFFS.CAP);
  const newPrice  = applyFloor(currentPrice * (1 + capped));
  const pctChange = pct(newPrice, currentPrice);
  return {
    newPrice, pctChange, breakdown,
    upsetCoeff: (isUpset || isUpsetLoss) ? coeff : null,
    log: { trigger: 'playoff_game', description: `R${round} ${won?'Victoire':'Defaite'}${overtime?' OT':''}${isUpset?` (upset x${coeff})`:''} — ${pctChange>=0?'+':''}${pctChange}%`, pctChange, round },
  };
}

function applyPlayoffSweep(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 + PLAYOFFS.SWEEP_BONUS));
  const pctChange = pct(newPrice, currentPrice);
  return { newPrice, pctChange, breakdown: [{ rule: 'Balayage 4-0', basePct: PLAYOFFS.SWEEP_BONUS, positive: true }], log: { trigger: 'sweep', description: `Balayage 4-0 — +${(PLAYOFFS.SWEEP_BONUS*100).toFixed(0)}%`, pctChange } };
}

function applyPlayoffComeback(currentPrice, upsetCoeff = 1.0) {
  const raw = Math.min(PLAYOFFS.COMEBACK_BONUS * upsetCoeff, PLAYOFFS.CAP);
  const newPrice  = applyFloor(currentPrice * (1 + raw));
  const pctChange = pct(newPrice, currentPrice);
  return { newPrice, pctChange, breakdown: [{ rule: `Remontee 0-3${upsetCoeff>1?` x${upsetCoeff}`:''}`, basePct: raw, positive: true }], log: { trigger: 'comeback_0_3', description: `Remontee 0-3 — +${(raw*100).toFixed(1)}%`, pctChange } };
}

function applyUpsetseries(currentPrice, upsetCoeff = 1.0, isWinner = true) {
  const base = isWinner ? PLAYOFFS.UPSET_WIN_BASE : -PLAYOFFS.UPSET_LOSS_BASE;
  const raw  = Math.min(Math.abs(base * upsetCoeff), PLAYOFFS.CAP) * Math.sign(base);
  const newPrice  = applyFloor(currentPrice * (1 + raw));
  const pctChange = pct(newPrice, currentPrice);
  const label = isWinner ? `Victoire upset serie x${upsetCoeff}` : `Defaite surprise serie x${upsetCoeff}`;
  return { newPrice, pctChange, breakdown: [{ rule: label, basePct: Math.abs(raw), positive: isWinner }], log: { trigger: 'upset_series_win', description: `${label} — ${pctChange>=0?'+':''}${pctChange}%`, pctChange } };
}

function applyChampion(currentPrice) {
  const newPrice  = applyFloor(currentPrice * (1 + PLAYOFFS.CHAMPION_BONUS));
  const pctChange = pct(newPrice, currentPrice);
  return { newPrice, pctChange, breakdown: [{ rule: 'Champion Coupe Stanley', basePct: PLAYOFFS.CHAMPION_BONUS, positive: true }], log: { trigger: 'champion', description: `Champion Coupe Stanley — +${(PLAYOFFS.CHAMPION_BONUS*100).toFixed(0)}%`, pctChange } };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  applyGameResult, applyStandingsAdjustment, applyPlayoffClinch,
  applyElimination, streakMultiplier, ALGO: REGULAR,
  applyPlayoffGameResult, applyPlayoffSweep, applyPlayoffComeback,
  applyUpsetseries, applyChampion, upsetCoefficient, detectUpset,
  REGULAR, PLAYOFFS,
};
