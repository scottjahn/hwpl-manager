// Pure stat computation, ported from the old T-SQL queries in api/src/functions.
// Input is the raw object graph from tools/db.mjs#loadRaw; output matches the
// JSON shapes the frontend already consumes (src/types.ts). Used by both the
// static export (tools/export.mjs) and the dev admin server (tools/admin-server.mjs).

const fullName = (p) => `${p.firstName} ${p.lastName}`;
const winRate = (wins, gp) => (gp === 0 ? 0 : wins / gp);

const acc0 = () => ({ gp: 0, wins: 0, pf: 0, pa: 0 });
const add = (a, pf, pa) => {
  a.gp += 1;
  if (pf > pa) a.wins += 1;
  a.pf += pf;
  a.pa += pa;
};

const statBody = (a) => ({
  gamesPlayed: a.gp,
  wins: a.wins,
  losses: a.gp - a.wins,
  pointsFor: a.pf,
  pointsAgainst: a.pa,
  differential: a.pf - a.pa,
  winRate: winRate(a.wins, a.gp),
});
const statsRow = (id, name, a) => ({ id, name, ...statBody(a) });

// Matches the old "ORDER BY wins DESC, winRate DESC, differential DESC".
const byWins = (x, y) =>
  y.wins - x.wins || y.winRate - x.winRate || y.differential - x.differential;

function buildIndexes(raw) {
  return {
    playerById: new Map(raw.players.map((p) => [p.id, p])),
    teamById: new Map(raw.teams.map((t) => [t.id, t])),
    courtById: new Map(raw.courts.map((c) => [c.id, c])),
    locationById: new Map((raw.locations ?? []).map((l) => [l.id, l])),
    leagueById: new Map(raw.leagues.map((l) => [l.id, l])),
  };
}

const playerName = (id, idx) => {
  const p = idx.playerById.get(id);
  return p ? fullName(p) : 'Unknown Player';
};

// First names of one side, joined " & " (ordered) — used to label Ladder matches.
function sideName(match, side, idx) {
  return match.participants
    .filter((p) => p.teamSide === side)
    .sort((a, b) => a.participantOrder - b.participantOrder)
    .map((p) => idx.playerById.get(p.playerId)?.firstName ?? '?')
    .join(' & ');
}

const teamAName = (m, idx) =>
  m.gameType === 'Ladder'
    ? sideName(m, 'A', idx) || 'Ladder Side A'
    : idx.teamById.get(m.teamAId)?.name ?? 'Ladder Side A';
const teamBName = (m, idx) =>
  m.gameType === 'Ladder'
    ? sideName(m, 'B', idx) || 'Ladder Side B'
    : idx.teamById.get(m.teamBId)?.name ?? 'Ladder Side B';

export function computePlayers(raw, idx) {
  const accs = new Map();
  for (const m of raw.matches) {
    for (const part of m.participants) {
      const a = accs.get(part.playerId) ?? acc0();
      const pf = part.teamSide === 'A' ? m.scoreA : m.scoreB;
      const pa = part.teamSide === 'A' ? m.scoreB : m.scoreA;
      add(a, pf, pa);
      accs.set(part.playerId, a);
    }
  }
  return [...accs.entries()]
    .filter(([, a]) => a.gp > 0)
    .map(([id, a]) => statsRow(id, playerName(id, idx), a))
    .sort(byWins);
}

export function computeTeams(raw, idx) {
  const accs = new Map();
  for (const m of raw.matches) {
    if (m.gameType !== 'Doubles' || !m.teamAId || !m.teamBId) continue;
    const a = accs.get(m.teamAId) ?? acc0();
    add(a, m.scoreA, m.scoreB);
    accs.set(m.teamAId, a);
    const b = accs.get(m.teamBId) ?? acc0();
    add(b, m.scoreB, m.scoreA);
    accs.set(m.teamBId, b);
  }
  return [...accs.entries()]
    .map(([id, a]) => statsRow(id, idx.teamById.get(id)?.name ?? 'Unknown Team', a))
    .sort(byWins);
}

// raw.matches is pre-sorted match_date DESC, created_at DESC.
export const computeRecentMatches = (raw, idx, limit = 10) =>
  raw.matches.slice(0, limit).map((m) => ({
    id: m.id,
    date: m.matchDate,
    teamA: teamAName(m, idx),
    teamB: teamBName(m, idx),
    scoreA: m.scoreA,
    scoreB: m.scoreB,
  }));

export const computeMatchesFull = (raw, idx) =>
  raw.matches.map((m) => {
    const league = idx.leagueById.get(m.leagueId);
    return {
      id: m.id,
      date: m.matchDate,
      leagueId: m.leagueId,
      leagueName: league?.name ?? '',
      leagueStartDate: league?.startDate ?? '',
      leagueEndDate: league?.endDate ?? '',
      courtId: m.courtId,
      courtName: idx.courtById.get(m.courtId)?.name ?? 'Unassigned Court',
      locationId: m.locationId ?? null,
      locationName: idx.locationById.get(m.locationId)?.name ?? '',
      scoringType: m.scoringType,
      gameType: m.gameType,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      teamAName: teamAName(m, idx),
      teamBName: teamBName(m, idx),
      scoreA: m.scoreA,
      scoreB: m.scoreB,
      participants: m.participants
        .slice()
        .sort((a, b) =>
          a.teamSide < b.teamSide ? -1
          : a.teamSide > b.teamSide ? 1
          : a.participantOrder - b.participantOrder
        )
        .map((p) => ({
          playerId: p.playerId,
          playerName: playerName(p.playerId, idx),
          teamSide: p.teamSide,
          participantOrder: p.participantOrder,
          teamId: p.teamId,
        })),
    };
  });

export const computeLeagues = (raw) =>
  raw.leagues
    .map((l) => {
      const ms = raw.matches.filter((m) => m.leagueId === l.id);
      const totalPts = ms.reduce((s, m) => s + m.scoreA + m.scoreB, 0);
      return {
        id: l.id,
        name: l.name,
        startDate: l.startDate,
        endDate: l.endDate,
        isActive: l.isActive,
        matches: ms.length,
        avgPointsPerMatch: ms.length === 0 ? 0 : totalPts / ms.length,
      };
    })
    .sort((a, b) =>
      a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : a.name.localeCompare(b.name)
    );

export const computeSessionDates = (raw) =>
  [...new Set(raw.matches.map((m) => m.matchDate))].sort((a, b) => b.localeCompare(a));

// Per-court team (Doubles) and player (Ladder) stats for a single date.
// Like the old query, this only includes matches with a court assigned.
export function computeSession(raw, idx, date) {
  const courts = new Map();
  const ensure = (courtId) => {
    if (!courts.has(courtId)) {
      courts.set(courtId, {
        courtId,
        courtName: idx.courtById.get(courtId)?.name ?? 'Unassigned Court',
        doubles: new Map(),
        ladder: new Map(),
      });
    }
    return courts.get(courtId);
  };

  for (const m of raw.matches) {
    if (m.matchDate !== date || !m.courtId) continue;

    if (m.gameType === 'Doubles' && m.teamAId && m.teamBId) {
      const c = ensure(m.courtId);
      const a = c.doubles.get(m.teamAId) ?? acc0();
      add(a, m.scoreA, m.scoreB);
      c.doubles.set(m.teamAId, a);
      const b = c.doubles.get(m.teamBId) ?? acc0();
      add(b, m.scoreB, m.scoreA);
      c.doubles.set(m.teamBId, b);
    } else if (m.gameType === 'Ladder') {
      const c = ensure(m.courtId);
      for (const part of m.participants) {
        const pf = part.teamSide === 'A' ? m.scoreA : m.scoreB;
        const pa = part.teamSide === 'A' ? m.scoreB : m.scoreA;
        const a = c.ladder.get(part.playerId) ?? acc0();
        add(a, pf, pa);
        c.ladder.set(part.playerId, a);
      }
    }
  }

  return [...courts.values()]
    .map((c) => ({
      courtId: c.courtId,
      courtName: c.courtName,
      doubles: [...c.doubles.entries()]
        .map(([teamId, a]) => ({
          teamId,
          teamName: idx.teamById.get(teamId)?.name ?? 'Unknown Team',
          ...statBody(a),
        }))
        .sort(byWins),
      ladder: [...c.ladder.entries()]
        .map(([playerId, a]) => ({
          playerId,
          playerName: playerName(playerId, idx),
          ...statBody(a),
        }))
        .sort(byWins),
    }))
    .sort((x, y) => x.courtName.localeCompare(y.courtName));
}

/** Everything the public site needs, keyed by the static file it maps to. */
export function computeAll(raw) {
  const idx = buildIndexes(raw);
  const sessionDates = computeSessionDates(raw);
  return {
    idx,
    players: computePlayers(raw, idx),
    teams: computeTeams(raw, idx),
    matches: computeRecentMatches(raw, idx),
    matchesFull: computeMatchesFull(raw, idx),
    leagues: computeLeagues(raw),
    sessionDates,
    sessions: Object.fromEntries(sessionDates.map((d) => [d, computeSession(raw, idx, d)])),
  };
}

export { buildIndexes };
