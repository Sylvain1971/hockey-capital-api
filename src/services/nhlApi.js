'use strict';
/**
 * Hockey Capital — Service API LNH
 * Source: api-web.nhle.com/v1 (API officielle, non-documentée, gratuite)
 */

const BASE = 'https://api-web.nhle.com/v1';

// Mapping abréviations LNH → IDs Hockey Capital
const NHL_TO_HC = {
  MTL:'MTL', BOS:'BOS', TOR:'TOR', TBL:'TBL', FLA:'FLA', OTT:'OTT', BUF:'BUF', DET:'DET',
  NYR:'NYR', PHI:'PHI', PIT:'PIT', WSH:'WSH', NJD:'NJD', NYI:'NYI', CAR:'CAR', CBJ:'CBJ',
  CHI:'CHI', NSH:'NSH', STL:'STL', COL:'COL', MIN:'MIN', DAL:'DAL', WPG:'WPG', UTA:'UTA',
  VGK:'VGK', EDM:'EDM', CGY:'CGY', VAN:'VAN', SEA:'SEA', SJS:'SJS', ANA:'ANA', LAK:'LAK',
};

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Récupère les scores du jour ET d'hier (matchs finaux des deux jours)
 * Les matchs LNH finissent souvent après minuit — on doit checker les deux dates
 */
async function fetchScores(date = null) {
  if (date) {
    const res = await fetch(`${BASE}/score/${date}`);
    if (!res.ok) throw new Error(`NHL scores API ${res.status}`);
    const data = await res.json();
    return parseGames(data.games || []);
  }

  // Sans date: chercher aujourd'hui + hier pour ne rien manquer
  const [resT, resY] = await Promise.all([
    fetch(`${BASE}/score/${todayStr()}`),
    fetch(`${BASE}/score/${yesterdayStr()}`),
  ]);

  const [dataT, dataY] = await Promise.all([
    resT.ok ? resT.json() : { games: [] },
    resY.ok ? resY.json() : { games: [] },
  ]);

  const gamesT = parseGames(dataT.games || []);
  const gamesY = parseGames(dataY.games || []);

  // Combiner, dédupliquer par gameId
  const seen = new Set();
  const all = [];
  for (const g of [...gamesT, ...gamesY]) {
    if (!seen.has(g.gameId)) { seen.add(g.gameId); all.push(g); }
  }
  return all;
}

/**
 * Récupère le classement actuel
 */
async function fetchStandings() {
  const res = await fetch(`${BASE}/standings/now`);
  if (!res.ok) throw new Error(`NHL standings API ${res.status}`);
  const data = await res.json();
  return parseStandings(data.standings || []);
}

/**
 * Normalise un match LNH → format Hockey Capital
 */
function parseGames(rawGames) {
  return rawGames.map(g => {
    const homeAbbr = g.homeTeam?.abbrev;
    const awayAbbr = g.awayTeam?.abbrev;
    const homeGoals = g.homeTeam?.score ?? null;
    const awayGoals = g.awayTeam?.score ?? null;
    const state = g.gameState; // PRE, LIVE, CRIT, FINAL, OFF
    const periodType = g.periodDescriptor?.periodType; // REG, OT, SO
    const isOvertime = periodType === 'OT' || periodType === 'SO';
    const isFinal = state === 'FINAL' || state === 'OFF';
    const isLive = state === 'LIVE' || state === 'CRIT';

    let homeResult = null;
    let awayResult = null;

    if (isFinal && homeGoals !== null && awayGoals !== null) {
      const homeWon = homeGoals > awayGoals;
      const shutout = homeGoals === 0 || awayGoals === 0;
      homeResult = {
        teamId: NHL_TO_HC[homeAbbr],
        won: homeWon,
        overtime: isOvertime,
        shutout: homeWon && homeGoals > 0 && awayGoals === 0,
      };
      awayResult = {
        teamId: NHL_TO_HC[awayAbbr],
        won: !homeWon,
        overtime: isOvertime,
        shutout: !homeWon && awayGoals > 0 && homeGoals === 0,
      };
    }

    return {
      gameId: String(g.id),
      state,
      isFinal,
      isLive,
      isOvertime,
      homeTeam: { id: NHL_TO_HC[homeAbbr], abbrev: homeAbbr, goals: homeGoals },
      awayTeam: { id: NHL_TO_HC[awayAbbr], abbrev: awayAbbr, goals: awayGoals },
      startTimeUTC: g.startTimeUTC,
      period: g.periodDescriptor?.number,
      periodType,
      clock: g.clock?.timeRemaining,
      homeResult,
      awayResult,
    };
  });
}

/**
 * Normalise le classement LNH → format Hockey Capital
 */
function parseStandings(rawStandings) {
  return rawStandings.map(s => ({
    teamId: NHL_TO_HC[s.teamAbbrev?.default],
    abbrev: s.teamAbbrev?.default,
    conference: s.conferenceName === 'Eastern' ? 'Est' : 'Ouest',
    division: s.divisionName,
    divisionRank: s.divisionSequence,
    wildcardRank: s.wildcardSequence,
    gamesPlayed: s.gamesPlayed || 0,
    wins: s.wins || 0,
    losses: s.losses || 0,
    otLosses: s.otLosses || 0,
    points: s.points || 0,
    goalsFor: s.goalFor || 0,
    goalsAgainst: s.goalAgainst || 0,
    clinched: s.clinchIndicator === 'x' || s.clinchIndicator === 'y' || s.clinchIndicator === 'z',
  })).filter(s => s.teamId); // exclure équipes non mappées
}

module.exports = { fetchScores, fetchStandings, NHL_TO_HC, todayStr };
