// Flattens the raw object graph from tools/db.mjs#loadRaw into the two JSON
// shapes the frontend consumes (src/types.ts): the full match list and the
// league list. Every derived table — player and team standings, per-session
// court results, recent matches — is computed in the browser from the match
// list, so it is deliberately not duplicated here. Used by both the static
// export (tools/export.mjs) and the dev admin server (tools/admin-server.mjs).

const fullName = (p) => `${p.firstName} ${p.lastName}`;

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

// raw.matches is pre-sorted match_date DESC, created_at DESC; the frontend
// relies on that order for its "recent matches" list.
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
        messageHtml: l.messageHtml ?? '',
        matches: ms.length,
        avgPointsPerMatch: ms.length === 0 ? 0 : totalPts / ms.length,
      };
    })
    .sort((a, b) =>
      a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : a.name.localeCompare(b.name)
    );

/** Everything the public site needs, keyed by the static file it maps to. */
export function computeAll(raw) {
  const idx = buildIndexes(raw);
  return {
    matchesFull: computeMatchesFull(raw, idx),
    leagues: computeLeagues(raw),
  };
}
