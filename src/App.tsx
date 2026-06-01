import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicMatch, RecentMatch, SessionCourtEntry, StatsRow } from "./types";
import { statsUrl, sessionUrl } from "./dataSource";

interface StatAccumulator {
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
}

interface LeagueAggregate {
  leagueId: string;
  leagueName: string;
  leagueStartDate: string;
  overall: StatsRow;
  courts: StatsRow[];
}

interface TeamAggregate {
  key: string;
  label: string;
  overall: StatsRow;
  courts: StatsRow[];
}

interface PlayerLeagueAggregate {
  leagueId: string;
  leagueName: string;
  leagueStartDate: string;
  overall: StatsRow;
  teams: TeamAggregate[];
}

const createAccumulator = (): StatAccumulator => ({
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  pointsFor: 0,
  pointsAgainst: 0
});

const addGame = (acc: StatAccumulator, pointsFor: number, pointsAgainst: number) => {
  acc.gamesPlayed += 1;
  if (pointsFor > pointsAgainst) acc.wins += 1;
  else acc.losses += 1;
  acc.pointsFor += pointsFor;
  acc.pointsAgainst += pointsAgainst;
};

const toStatsRow = (id: string, name: string, acc: StatAccumulator): StatsRow => {
  const differential = acc.pointsFor - acc.pointsAgainst;
  const winRate = acc.gamesPlayed === 0 ? 0 : acc.wins / acc.gamesPlayed;
  return {
    id,
    name,
    gamesPlayed: acc.gamesPlayed,
    wins: acc.wins,
    losses: acc.losses,
    pointsFor: acc.pointsFor,
    pointsAgainst: acc.pointsAgainst,
    differential,
    winRate
  };
};

const byGamesPlayedDesc = (a: StatsRow, b: StatsRow) => (
  b.gamesPlayed - a.gamesPlayed
  || b.wins - a.wins
  || b.winRate - a.winRate
  || b.differential - a.differential
  || a.name.localeCompare(b.name)
);

const byLeagueDesc = <T extends { leagueStartDate: string; leagueName: string }>(a: T, b: T) => (
  b.leagueStartDate.localeCompare(a.leagueStartDate) || a.leagueName.localeCompare(b.leagueName)
);

const decodePathSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// ── Slug helpers ─────────────────────────────────────────────────────────────
// Convert display names to URL-safe slugs. Diacritics are stripped, non-
// alphanumeric runs become a single hyphen. Collisions get a -2, -3 suffix.

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "")
   .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function buildSlugMap(nameById: Map<string, string>): [Map<string, string>, Map<string, string>] {
  const slugById = new Map<string, string>();
  const bySlug   = new Map<string, string>();
  for (const [id, name] of nameById) {
    const base = slugify(name);
    let slug = base; let n = 2;
    while (bySlug.has(slug)) slug = `${base}-${n++}`;
    bySlug.set(slug, id);
    slugById.set(id, slug);
  }
  return [slugById, bySlug];
}

// Module-level maps refreshed synchronously each render from loaded data.
// Placing them here keeps TeamLink / PlayerLink as simple module-level components.
let gPlayerSlugById = new Map<string, string>();
let gPlayerBySlug   = new Map<string, string>();
let gTeamSlugById   = new Map<string, string>();
let gTeamBySlug     = new Map<string, string>();

const getPlayerRoute = (id: string) =>
  `/player/${gPlayerSlugById.get(id) ?? encodeURIComponent(id)}`;
const getTeamRoute = (id: string | null) =>
  id ? `/team/${gTeamSlugById.get(id) ?? encodeURIComponent(id)}` : null;

const TeamLink = ({ id, name }: { id: string | null; name: string }) => (
  id ? <a className="entity-link" href={getTeamRoute(id)!}>{name}</a> : <span>{name}</span>
);

const PlayerLink = ({ id, name }: { id: string; name: string }) => (
  <a className="entity-link" href={getPlayerRoute(id)}>{name}</a>
);

const getAllMatchPlayerNames = (match: PublicMatch): string[] => (
  [...match.participants]
    .sort((a, b) => {
      const sideDelta = (a.teamSide === "A" ? 0 : 1) - (b.teamSide === "A" ? 0 : 1);
      if (sideDelta !== 0) return sideDelta;
      return a.participantOrder - b.participantOrder;
    })
    .map((participant) => participant.playerName)
);

const getPlayerSideForMatch = (match: PublicMatch, playerId: string) => {
  const participant = match.participants.find((entry) => entry.playerId === playerId);
  if (!participant) return null;
  return participant.teamSide;
};

const getPlayerTeamKeyAndLabel = (match: PublicMatch, playerId: string) => {
  const side = getPlayerSideForMatch(match, playerId);
  if (!side) return { key: "", label: "" };
  if (match.gameType === "Ladder") return { key: "ladder", label: "Ladder" };
  if (side === "A") return { key: match.teamAId ?? "", label: match.teamAName };
  return { key: match.teamBId ?? "", label: match.teamBName };
};

const getOpponentTeamForPlayer = (match: PublicMatch, playerId: string) => {
  const side = getPlayerSideForMatch(match, playerId);
  if (!side) return { id: null, name: "" };
  if (match.gameType === "Ladder") return { id: null, name: "Ladder" };
  if (side === "A") return { id: match.teamBId, name: match.teamBName };
  return { id: match.teamAId, name: match.teamAName };
};

const TeamDetailView = ({
  teamId,
  matches,
  teamNameById,
  playerNameById
}: {
  teamId: string;
  matches: PublicMatch[];
  teamNameById: Map<string, string>;
  playerNameById: Map<string, string>;
}) => {
  const teamName = teamNameById.get(teamId) ?? "Unknown Team";

  const teamMatches = useMemo(
    () => matches.filter((match) => match.gameType === "Doubles" && (match.teamAId === teamId || match.teamBId === teamId)),
    [matches, teamId]
  );

  const leagueAggregates = useMemo(() => {
    const leagues = new Map<string, {
      leagueId: string;
      leagueName: string;
      leagueStartDate: string;
      overall: StatAccumulator;
      courts: Map<string, { name: string; acc: StatAccumulator }>;
    }>();

    for (const match of teamMatches) {
      const side = match.teamAId === teamId ? "A" : "B";
      const pointsFor = side === "A" ? match.scoreA : match.scoreB;
      const pointsAgainst = side === "A" ? match.scoreB : match.scoreA;
      const league = leagues.get(match.leagueId) ?? {
        leagueId: match.leagueId,
        leagueName: match.leagueName,
        leagueStartDate: match.leagueStartDate,
        overall: createAccumulator(),
        courts: new Map()
      };

      addGame(league.overall, pointsFor, pointsAgainst);

      const courtKey = match.courtId ?? "no-court";
      const courtEntry = league.courts.get(courtKey) ?? { name: match.courtName, acc: createAccumulator() };
      addGame(courtEntry.acc, pointsFor, pointsAgainst);
      league.courts.set(courtKey, courtEntry);
      leagues.set(match.leagueId, league);
    }

    return Array.from(leagues.values())
      .map<LeagueAggregate>((league) => ({
        leagueId: league.leagueId,
        leagueName: league.leagueName,
        leagueStartDate: league.leagueStartDate,
        overall: toStatsRow(league.leagueId, league.leagueName, league.overall),
        courts: Array.from(league.courts.entries())
          .map(([courtId, value]) => toStatsRow(courtId, value.name, value.acc))
          .sort(byGamesPlayedDesc)
      }))
      .sort(byLeagueDesc);
  }, [teamMatches, teamId]);

  const teamPlayerRows = useMemo(() => {
    const players = new Map<string, StatAccumulator>();

    for (const match of teamMatches) {
      const teamOnSideA = match.teamAId === teamId;
      const pointsFor = teamOnSideA ? match.scoreA : match.scoreB;
      const pointsAgainst = teamOnSideA ? match.scoreB : match.scoreA;

      for (const participant of match.participants.filter((entry) => entry.teamId === teamId)) {
        const acc = players.get(participant.playerId) ?? createAccumulator();
        addGame(acc, pointsFor, pointsAgainst);
        players.set(participant.playerId, acc);
      }
    }

    return Array.from(players.entries())
      .map(([playerId, acc]) => toStatsRow(playerId, playerNameById.get(playerId) ?? "Unknown Player", acc))
      .sort(byGamesPlayedDesc);
  }, [playerNameById, teamMatches, teamId]);

  const versusRows = useMemo(() => {
    const rows = new Map<string, {
      leagueName: string;
      leagueStartDate: string;
      opponentId: string;
      opponentName: string;
      acc: StatAccumulator;
    }>();

    for (const match of teamMatches) {
      const side = match.teamAId === teamId ? "A" : "B";
      const opponentId = side === "A" ? match.teamBId : match.teamAId;
      const opponentName = side === "A" ? match.teamBName : match.teamAName;
      if (!opponentId) continue;

      const key = `${match.leagueId}:${opponentId}`;
      const item = rows.get(key) ?? {
        leagueName: match.leagueName,
        leagueStartDate: match.leagueStartDate,
        opponentId,
        opponentName,
        acc: createAccumulator()
      };
      const pointsFor = side === "A" ? match.scoreA : match.scoreB;
      const pointsAgainst = side === "A" ? match.scoreB : match.scoreA;
      addGame(item.acc, pointsFor, pointsAgainst);
      rows.set(key, item);
    }

    return Array.from(rows.values())
      .map((item) => ({
        leagueName: item.leagueName,
        leagueStartDate: item.leagueStartDate,
        opponentId: item.opponentId,
        row: toStatsRow(item.opponentId, item.opponentName, item.acc)
      }))
      .sort((a, b) => (
        b.row.gamesPlayed - a.row.gamesPlayed
        || b.row.differential - a.row.differential
        || a.row.name.localeCompare(b.row.name)
        || byLeagueDesc(a, b)
      ));
  }, [teamMatches, teamId]);

  const leagueOptions = useMemo(() => {
    const leagues = new Map<string, { name: string; startDate: string }>();
    for (const match of teamMatches) {
      leagues.set(match.leagueId, { name: match.leagueName, startDate: match.leagueStartDate });
    }
    return Array.from(leagues.entries())
      .map(([id, value]) => ({ id, name: value.name, startDate: value.startDate }))
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.name.localeCompare(b.name));
  }, [teamMatches]);

  const opponentOptions = useMemo(() => {
    const teams = new Map<string, string>();
    for (const match of teamMatches) {
      if (match.teamAId === teamId && match.teamBId) teams.set(match.teamBId, match.teamBName);
      if (match.teamBId === teamId && match.teamAId) teams.set(match.teamAId, match.teamAName);
    }
    return Array.from(teams.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [teamMatches, teamId]);

  const playerOptions = useMemo(() => {
    const players = new Set<string>();
    for (const match of teamMatches) {
      for (const participant of match.participants) players.add(participant.playerId);
    }
    return Array.from(players)
      .map((id) => ({ id, name: playerNameById.get(id) ?? "Unknown Player" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [playerNameById, teamMatches]);

  const dateOptions = useMemo(() => Array.from(new Set(teamMatches.map((match) => match.date))).sort((a, b) => b.localeCompare(a)), [teamMatches]);

  const [leagueFilter, setLeagueFilter] = useState("");
  const [opponentFilter, setOpponentFilter] = useState("");
  const [playerFilter, setPlayerFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");

  const filteredMatches = useMemo(
    () => teamMatches.filter((match) => {
      if (leagueFilter && match.leagueId !== leagueFilter) return false;
      if (dateFilter && match.date !== dateFilter) return false;

      const opponentId = match.teamAId === teamId ? match.teamBId : match.teamAId;
      if (opponentFilter && opponentId !== opponentFilter) return false;

      if (playerFilter && !match.participants.some((participant) => participant.playerId === playerFilter)) return false;
      return true;
    }),
    [dateFilter, leagueFilter, opponentFilter, playerFilter, teamId, teamMatches]
  );

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Team View</p>
        <h1>{teamName}</h1>
        <p>League and court performance, player contributions, opponents, and full match history.</p>
        <p><a className="hero-link" href="/">Back to main dashboard</a></p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Overall by League and Court</h3>
          <p>Leagues are ordered most recent first. Courts are ranked by games played.</p>
        </div>
        {leagueAggregates.length === 0 ? (
          <p>No doubles matches found for this team.</p>
        ) : leagueAggregates.map((league) => (
          <div key={league.leagueId} className="detail-block">
            <h4>{league.leagueName}</h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>GP</th>
                    <th>W</th>
                    <th>L</th>
                    <th>Win %</th>
                    <th>PF</th>
                    <th>PA</th>
                    <th>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>League Total</td>
                    <td>{league.overall.gamesPlayed}</td>
                    <td>{league.overall.wins}</td>
                    <td>{league.overall.losses}</td>
                    <td>{(league.overall.winRate * 100).toFixed(0)}%</td>
                    <td>{league.overall.pointsFor}</td>
                    <td>{league.overall.pointsAgainst}</td>
                    <td>{league.overall.differential}</td>
                  </tr>
                  {league.courts.map((court) => (
                    <tr key={court.id}>
                      <td>{court.name}</td>
                      <td>{court.gamesPlayed}</td>
                      <td>{court.wins}</td>
                      <td>{court.losses}</td>
                      <td>{(court.winRate * 100).toFixed(0)}%</td>
                      <td>{court.pointsFor}</td>
                      <td>{court.pointsAgainst}</td>
                      <td>{court.differential}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="grid-layout">
        <article className="panel">
          <div className="panel-header">
            <h3>Players on This Team</h3>
            <p>Ranked by games played while representing this team.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>GP</th>
                  <th>W</th>
                  <th>L</th>
                  <th>Win %</th>
                  <th>PF</th>
                  <th>PA</th>
                  <th>Diff</th>
                </tr>
              </thead>
              <tbody>
                {teamPlayerRows.map((row) => (
                  <tr key={row.id}>
                    <td><PlayerLink id={row.id} name={row.name} /></td>
                    <td>{row.gamesPlayed}</td>
                    <td>{row.wins}</td>
                    <td>{row.losses}</td>
                    <td>{(row.winRate * 100).toFixed(0)}%</td>
                    <td>{row.pointsFor}</td>
                    <td>{row.pointsAgainst}</td>
                    <td>{row.differential}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h3>Versus Other Teams</h3>
            <p>Per-league team matchups ranked by games played.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>League</th>
                  <th>Opponent</th>
                  <th>GP</th>
                  <th>W</th>
                  <th>L</th>
                  <th>Win %</th>
                  <th>PF</th>
                  <th>PA</th>
                  <th>Diff</th>
                </tr>
              </thead>
              <tbody>
                {versusRows.map((entry) => (
                  <tr key={`${entry.leagueName}-${entry.row.id}`}>
                    <td>{entry.leagueName}</td>
                    <td><TeamLink id={entry.opponentId} name={entry.row.name} /></td>
                    <td>{entry.row.gamesPlayed}</td>
                    <td>{entry.row.wins}</td>
                    <td>{entry.row.losses}</td>
                    <td>{(entry.row.winRate * 100).toFixed(0)}%</td>
                    <td>{entry.row.pointsFor}</td>
                    <td>{entry.row.pointsAgainst}</td>
                    <td>{entry.row.differential}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Match List</h3>
          <p>Filter by league, opponent team, player, or date.</p>
        </div>

        <div className="filter-row">
          <label>
            League
            <select value={leagueFilter} onChange={(event) => setLeagueFilter(event.target.value)}>
              <option value="">All leagues</option>
              {leagueOptions.map((league) => (
                <option key={league.id} value={league.id}>{league.name}</option>
              ))}
            </select>
          </label>

          <label>
            Team Played
            <select value={opponentFilter} onChange={(event) => setOpponentFilter(event.target.value)}>
              <option value="">All teams</option>
              {opponentOptions.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>

          <label>
            Player
            <select value={playerFilter} onChange={(event) => setPlayerFilter(event.target.value)}>
              <option value="">All players</option>
              {playerOptions.map((player) => (
                <option key={player.id} value={player.id}>{player.name}</option>
              ))}
            </select>
          </label>

          <label>
            Date
            <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
              <option value="">All dates</option>
              {dateOptions.map((date) => (
                <option key={date} value={date}>{date}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>League</th>
                <th>Court</th>
                <th>Team Played</th>
                <th>Score</th>
                <th>Players (All 4)</th>
              </tr>
            </thead>
            <tbody>
              {filteredMatches.map((match) => {
                const opponentId = match.teamAId === teamId ? match.teamBId : match.teamAId;
                const opponentName = match.teamAId === teamId ? match.teamBName : match.teamAName;
                const players = getAllMatchPlayerNames(match);
                const scoreText = match.teamAId === teamId
                  ? `${match.scoreA}-${match.scoreB}`
                  : `${match.scoreB}-${match.scoreA}`;

                return (
                  <tr key={match.id}>
                    <td>{match.date}</td>
                    <td>{match.leagueName}</td>
                    <td>{match.courtName}</td>
                    <td><TeamLink id={opponentId} name={opponentName} /></td>
                    <td>{scoreText}</td>
                    <td>{players.join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};

const PlayerDetailView = ({
  playerId,
  matches,
  playerNameById,
  teamNameById
}: {
  playerId: string;
  matches: PublicMatch[];
  playerNameById: Map<string, string>;
  teamNameById: Map<string, string>;
}) => {
  const playerName = playerNameById.get(playerId) ?? "Unknown Player";

  const playerMatches = useMemo(
    () => matches.filter((match) => match.participants.some((participant) => participant.playerId === playerId)),
    [matches, playerId]
  );

  const leagueTeamCourtBreakdown = useMemo(() => {
    const leagues = new Map<string, {
      leagueId: string;
      leagueName: string;
      leagueStartDate: string;
      overall: StatAccumulator;
      teams: Map<string, { label: string; overall: StatAccumulator; courts: Map<string, { name: string; acc: StatAccumulator }> }>;
    }>();

    for (const match of playerMatches) {
      const side = getPlayerSideForMatch(match, playerId);
      if (!side) continue;

      const pointsFor = side === "A" ? match.scoreA : match.scoreB;
      const pointsAgainst = side === "A" ? match.scoreB : match.scoreA;
      const teamMeta = getPlayerTeamKeyAndLabel(match, playerId);
      if (!teamMeta.key) continue;

      const league = leagues.get(match.leagueId) ?? {
        leagueId: match.leagueId,
        leagueName: match.leagueName,
        leagueStartDate: match.leagueStartDate,
        overall: createAccumulator(),
        teams: new Map()
      };
      addGame(league.overall, pointsFor, pointsAgainst);

      const team = league.teams.get(teamMeta.key) ?? {
        label: teamMeta.label,
        overall: createAccumulator(),
        courts: new Map()
      };
      addGame(team.overall, pointsFor, pointsAgainst);

      const courtKey = match.courtId ?? "no-court";
      const court = team.courts.get(courtKey) ?? { name: match.courtName, acc: createAccumulator() };
      addGame(court.acc, pointsFor, pointsAgainst);
      team.courts.set(courtKey, court);

      league.teams.set(teamMeta.key, team);
      leagues.set(match.leagueId, league);
    }

    return Array.from(leagues.values())
      .map<PlayerLeagueAggregate>((league) => ({
        leagueId: league.leagueId,
        leagueName: league.leagueName,
        leagueStartDate: league.leagueStartDate,
        overall: toStatsRow(league.leagueId, league.leagueName, league.overall),
        teams: Array.from(league.teams.entries())
          .map<TeamAggregate>(([key, team]) => ({
            key,
            label: team.label,
            overall: toStatsRow(key, team.label, team.overall),
            courts: Array.from(team.courts.entries())
              .map(([courtId, court]) => toStatsRow(courtId, court.name, court.acc))
              .sort(byGamesPlayedDesc)
          }))
          .sort((a, b) => byGamesPlayedDesc(a.overall, b.overall))
      }))
      .sort(byLeagueDesc);
  }, [playerId, playerMatches]);

  const versusPlayers = useMemo(() => {
    const rows = new Map<string, {
      leagueName: string;
      leagueStartDate: string;
      opponentId: string;
      opponentName: string;
      acc: StatAccumulator;
    }>();

    for (const match of playerMatches) {
      const side = getPlayerSideForMatch(match, playerId);
      if (!side) continue;

      const pointsFor = side === "A" ? match.scoreA : match.scoreB;
      const pointsAgainst = side === "A" ? match.scoreB : match.scoreA;

      for (const opponent of match.participants.filter((participant) => participant.teamSide !== side)) {
        const key = `${match.leagueId}:${opponent.playerId}`;
        const row = rows.get(key) ?? {
          leagueName: match.leagueName,
          leagueStartDate: match.leagueStartDate,
          opponentId: opponent.playerId,
          opponentName: opponent.playerName,
          acc: createAccumulator()
        };
        addGame(row.acc, pointsFor, pointsAgainst);
        rows.set(key, row);
      }
    }

    return Array.from(rows.values())
      .map((item) => ({
        leagueName: item.leagueName,
        leagueStartDate: item.leagueStartDate,
        opponentId: item.opponentId,
        row: toStatsRow(item.opponentId, item.opponentName, item.acc)
      }))
      .sort((a, b) => (
        b.row.gamesPlayed - a.row.gamesPlayed
        || b.row.differential - a.row.differential
        || a.row.name.localeCompare(b.row.name)
        || byLeagueDesc(a, b)
      ));
  }, [playerId, playerMatches]);

  const leagueOptions = useMemo(() => {
    const leagues = new Map<string, { name: string; startDate: string }>();
    for (const match of playerMatches) {
      leagues.set(match.leagueId, { name: match.leagueName, startDate: match.leagueStartDate });
    }
    return Array.from(leagues.entries())
      .map(([id, value]) => ({ id, name: value.name, startDate: value.startDate }))
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.name.localeCompare(b.name));
  }, [playerMatches]);

  const teamOptions = useMemo(() => {
    const teams = new Map<string, string>();
    for (const match of playerMatches) {
      const teamMeta = getPlayerTeamKeyAndLabel(match, playerId);
      if (!teamMeta.key) continue;
      const label = teamMeta.key === "ladder"
        ? "Ladder"
        : teamNameById.get(teamMeta.key) ?? teamMeta.label;
      teams.set(teamMeta.key, label);
    }
    return Array.from(teams.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [playerId, playerMatches, teamNameById]);

  const relatedPlayerOptions = useMemo(() => {
    const players = new Set<string>();
    for (const match of playerMatches) {
      for (const participant of match.participants) {
        if (participant.playerId !== playerId) players.add(participant.playerId);
      }
    }
    return Array.from(players)
      .map((id) => ({ id, name: playerNameById.get(id) ?? "Unknown Player" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [playerId, playerMatches, playerNameById]);

  const dateOptions = useMemo(() => Array.from(new Set(playerMatches.map((match) => match.date))).sort((a, b) => b.localeCompare(a)), [playerMatches]);

  const [leagueFilter, setLeagueFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [playerFilter, setPlayerFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");

  const filteredMatches = useMemo(
    () => playerMatches.filter((match) => {
      if (leagueFilter && match.leagueId !== leagueFilter) return false;
      if (dateFilter && match.date !== dateFilter) return false;

      const teamMeta = getPlayerTeamKeyAndLabel(match, playerId);
      if (teamFilter && teamMeta.key !== teamFilter) return false;

      if (playerFilter && !match.participants.some((participant) => participant.playerId === playerFilter)) return false;
      return true;
    }),
    [dateFilter, leagueFilter, playerFilter, playerId, playerMatches, teamFilter]
  );

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Player View</p>
        <h1>{playerName}</h1>
        <p>League/team/court performance, head-to-head trends, and complete match history.</p>
        <p><a className="hero-link" href="/">Back to main dashboard</a></p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Overall by League, Team, and Court</h3>
          <p>Ladder matches are grouped under team name Ladder.</p>
        </div>
        {leagueTeamCourtBreakdown.length === 0 ? (
          <p>No matches found for this player.</p>
        ) : leagueTeamCourtBreakdown.map((league) => (
          <div key={league.leagueId} className="detail-block">
            <h4>{league.leagueName}</h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>GP</th>
                    <th>W</th>
                    <th>L</th>
                    <th>Win %</th>
                    <th>PF</th>
                    <th>PA</th>
                    <th>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>League Total</td>
                    <td>{league.overall.gamesPlayed}</td>
                    <td>{league.overall.wins}</td>
                    <td>{league.overall.losses}</td>
                    <td>{(league.overall.winRate * 100).toFixed(0)}%</td>
                    <td>{league.overall.pointsFor}</td>
                    <td>{league.overall.pointsAgainst}</td>
                    <td>{league.overall.differential}</td>
                  </tr>
                  {league.teams.map((team) => (
                    <tr key={`${league.leagueId}-${team.key}`}>
                      <td>{team.key === "ladder" ? team.label : <TeamLink id={team.key} name={team.label} />}</td>
                      <td>{team.overall.gamesPlayed}</td>
                      <td>{team.overall.wins}</td>
                      <td>{team.overall.losses}</td>
                      <td>{(team.overall.winRate * 100).toFixed(0)}%</td>
                      <td>{team.overall.pointsFor}</td>
                      <td>{team.overall.pointsAgainst}</td>
                      <td>{team.overall.differential}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {league.teams.map((team) => (
              <div key={`${league.leagueId}-${team.key}-courts`} className="detail-subblock">
                <p>{team.key === "ladder" ? team.label : <TeamLink id={team.key} name={team.label} />} by Court</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Court</th>
                        <th>GP</th>
                        <th>W</th>
                        <th>L</th>
                        <th>Win %</th>
                        <th>PF</th>
                        <th>PA</th>
                        <th>Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.courts.map((court) => (
                        <tr key={`${team.key}-${court.id}`}>
                          <td>{court.name}</td>
                          <td>{court.gamesPlayed}</td>
                          <td>{court.wins}</td>
                          <td>{court.losses}</td>
                          <td>{(court.winRate * 100).toFixed(0)}%</td>
                          <td>{court.pointsFor}</td>
                          <td>{court.pointsAgainst}</td>
                          <td>{court.differential}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Against Other Players</h3>
          <p>Per-league head-to-head rows ranked by games played.</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>League</th>
                <th>Opponent</th>
                <th>GP</th>
                <th>W</th>
                <th>L</th>
                <th>Win %</th>
                <th>PF</th>
                <th>PA</th>
                <th>Diff</th>
              </tr>
            </thead>
            <tbody>
              {versusPlayers.map((entry) => (
                <tr key={`${entry.leagueName}-${entry.opponentId}`}>
                  <td>{entry.leagueName}</td>
                  <td><PlayerLink id={entry.opponentId} name={entry.row.name} /></td>
                  <td>{entry.row.gamesPlayed}</td>
                  <td>{entry.row.wins}</td>
                  <td>{entry.row.losses}</td>
                  <td>{(entry.row.winRate * 100).toFixed(0)}%</td>
                  <td>{entry.row.pointsFor}</td>
                  <td>{entry.row.pointsAgainst}</td>
                  <td>{entry.row.differential}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Match List</h3>
          <p>Filter by league, team, player, or date.</p>
        </div>

        <div className="filter-row">
          <label>
            League
            <select value={leagueFilter} onChange={(event) => setLeagueFilter(event.target.value)}>
              <option value="">All leagues</option>
              {leagueOptions.map((league) => (
                <option key={league.id} value={league.id}>{league.name}</option>
              ))}
            </select>
          </label>

          <label>
            Team
            <select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}>
              <option value="">All teams</option>
              {teamOptions.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>

          <label>
            Player
            <select value={playerFilter} onChange={(event) => setPlayerFilter(event.target.value)}>
              <option value="">All players</option>
              {relatedPlayerOptions.map((player) => (
                <option key={player.id} value={player.id}>{player.name}</option>
              ))}
            </select>
          </label>

          <label>
            Date
            <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
              <option value="">All dates</option>
              {dateOptions.map((date) => (
                <option key={date} value={date}>{date}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>League</th>
                <th>Court</th>
                <th>Team</th>
                <th>vs Team</th>
                <th>Score</th>
                <th>Players</th>
              </tr>
            </thead>
            <tbody>
              {filteredMatches.map((match) => {
                const side = getPlayerSideForMatch(match, playerId);
                const teamMeta = getPlayerTeamKeyAndLabel(match, playerId);
                const opponentTeam = getOpponentTeamForPlayer(match, playerId);
                const scoreText = side === "A" ? `${match.scoreA}-${match.scoreB}` : `${match.scoreB}-${match.scoreA}`;
                const playerNames = match.participants.map((participant) => participant.playerName).join(", ");

                return (
                  <tr key={match.id}>
                    <td>{match.date}</td>
                    <td>{match.leagueName}</td>
                    <td>{match.courtName}</td>
                    <td>{teamMeta.key === "ladder" ? teamMeta.label : <TeamLink id={teamMeta.key} name={teamMeta.label} />}</td>
                    <td>{opponentTeam.id ? <TeamLink id={opponentTeam.id} name={opponentTeam.name} /> : opponentTeam.name}</td>
                    <td>{scoreText}</td>
                    <td>{playerNames}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};

function App() {
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  const [playerStats, setPlayerStats] = useState<StatsRow[]>([]);
  const [teamStats, setTeamStats] = useState<StatsRow[]>([]);
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([]);
  const [publicMatches, setPublicMatches] = useState<PublicMatch[]>([]);

  const [sessionDates, setSessionDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [sessionData, setSessionData] = useState<SessionCourtEntry[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);

  const loadStats = useCallback(async () => {
    const [psRes, tsRes, rmRes, sdRes, pmRes] = await Promise.all([
      fetch(statsUrl("players")),
      fetch(statsUrl("teams")),
      fetch(statsUrl("matches")),
      fetch(statsUrl("session-dates")),
      fetch(statsUrl("matches-full"))
    ]);

    if (!psRes.ok || !tsRes.ok || !rmRes.ok || !sdRes.ok || !pmRes.ok) {
      throw new Error("Failed to load stats");
    }

    const [ps, ts, rm, sd, pm] = await Promise.all([
      psRes.json() as Promise<StatsRow[]>,
      tsRes.json() as Promise<StatsRow[]>,
      rmRes.json() as Promise<RecentMatch[]>,
      sdRes.json() as Promise<string[]>,
      pmRes.json() as Promise<PublicMatch[]>
    ]);

    setPlayerStats(ps);
    setTeamStats(ts);
    setRecentMatches(rm);
    setSessionDates(sd);
    setPublicMatches(pm);
    if (sd.length > 0) setSelectedDate(sd[0]);
  }, []);

  useEffect(() => {
    setLoading(true);
    setApiError(null);
    loadStats()
      .catch(() => setApiError("Could not reach the API. Verify deployment and SQL connection settings."))
      .finally(() => setLoading(false));
  }, [loadStats]);

  useEffect(() => {
    if (!selectedDate) return;
    setSessionLoading(true);
    fetch(sessionUrl(selectedDate))
      .then((response) => (response.ok ? response.json() as Promise<SessionCourtEntry[]> : Promise.reject()))
      .then((data) => setSessionData(data))
      .catch(() => setSessionData([]))
      .finally(() => setSessionLoading(false));
  }, [selectedDate]);

  const totalPlayers = playerStats.length;
  const totalTeams = teamStats.length;
  const totalSessions = sessionDates.length;

  const teamNameById = useMemo(() => {
    const map = new Map<string, string>(teamStats.map((team) => [team.id, team.name]));
    for (const match of publicMatches) {
      if (match.teamAId) map.set(match.teamAId, match.teamAName);
      if (match.teamBId) map.set(match.teamBId, match.teamBName);
    }
    return map;
  }, [publicMatches, teamStats]);

  const playerNameById = useMemo(() => {
    const map = new Map<string, string>(playerStats.map((player) => [player.id, player.name]));
    for (const match of publicMatches) {
      for (const participant of match.participants) {
        map.set(participant.playerId, participant.playerName);
      }
    }
    return map;
  }, [playerStats, publicMatches]);

  const teamIdByName = useMemo(
    () => new Map<string, string>(teamStats.map((team) => [team.name, team.id])),
    [teamStats]
  );

  // Refresh slug maps from the current data on every render. Both inputs are
  // Maps derived via useMemo so this is a pure derivation, not a side-effect.
  if (playerNameById.size > 0) {
    [gPlayerSlugById, gPlayerBySlug] = buildSlugMap(playerNameById);
  }
  if (teamNameById.size > 0) {
    [gTeamSlugById, gTeamBySlug] = buildSlugMap(teamNameById);
  }

  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const teamPathMatch = path.match(/^\/team\/([^/]+)$/i);
  const playerPathMatch = path.match(/^\/player\/([^/]+)$/i);
  const teamRouteSlug = teamPathMatch ? decodePathSegment(teamPathMatch[1]) : "";
  const playerRouteSlug = playerPathMatch ? decodePathSegment(playerPathMatch[1]) : "";
  // Resolve slug → ID (falls back to treating the segment as a raw ID for
  // any bookmarks that pre-date this change).
  const teamRouteId = teamRouteSlug ? (gTeamBySlug.get(teamRouteSlug) ?? "") : "";
  const playerRouteId = playerRouteSlug ? (gPlayerBySlug.get(playerRouteSlug) ?? "") : "";
  const showLoadingOverlay = loading || sessionLoading;

  return (
    <main className="app-shell">
      {teamRouteId ? (
        <TeamDetailView
          teamId={teamRouteId}
          matches={publicMatches}
          teamNameById={teamNameById}
          playerNameById={playerNameById}
        />
      ) : playerRouteId ? (
        <PlayerDetailView
          playerId={playerRouteId}
          matches={publicMatches}
          playerNameById={playerNameById}
          teamNameById={teamNameById}
        />
      ) : (
        <>
          <section className="hero">
            <div className="hero-brand-row">
              <img className="club-logo" src="/brand/HW PickleBall Logo.png" alt="Hiram Walker Pickleball Club logo" />
              <div>
                <p className="eyebrow">Hiram Walker Pickleball League</p>
                <h1>League Statistics Portal</h1>
              </div>
            </div>
            <p>View live league, team, player, and recent match statistics. Click any team or player name for detail pages.</p>

            {apiError ? <p className="panel status-msg" style={{ color: "#9a2f2f" }}>{apiError}</p> : null}

            <div className="hero-metrics">
              <article>
                <h2>{loading ? "..." : totalSessions}</h2>
                <p>Sessions</p>
              </article>
              <article>
                <h2>{loading ? "..." : totalPlayers}</h2>
                <p>Players</p>
              </article>
              <article>
                <h2>{loading ? "..." : totalTeams}</h2>
                <p>Teams</p>
              </article>
            </div>
          </section>

          <section className="grid-layout">
            <article className="panel">
              <div className="panel-header">
                <h3>Team Stats</h3>
                <p>Team totals include all matches where players represented that team.</p>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th>GP</th>
                      <th>W</th>
                      <th>L</th>
                      <th>Win %</th>
                      <th>PF</th>
                      <th>PA</th>
                      <th>Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamStats.map((row) => (
                      <tr key={row.id}>
                        <td><TeamLink id={row.id} name={row.name} /></td>
                        <td>{row.gamesPlayed}</td>
                        <td>{row.wins}</td>
                        <td>{row.losses}</td>
                        <td>{(row.winRate * 100).toFixed(0)}%</td>
                        <td>{row.pointsFor}</td>
                        <td>{row.pointsAgainst}</td>
                        <td>{row.differential}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="panel">
              <div className="panel-header">
                <h3>Player Stats</h3>
                <p>Includes games from default and non-default teams.</p>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>GP</th>
                      <th>W</th>
                      <th>L</th>
                      <th>Win %</th>
                      <th>PF</th>
                      <th>PA</th>
                      <th>Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerStats.map((row) => (
                      <tr key={row.id}>
                        <td><PlayerLink id={row.id} name={row.name} /></td>
                        <td>{row.gamesPlayed}</td>
                        <td>{row.wins}</td>
                        <td>{row.losses}</td>
                        <td>{(row.winRate * 100).toFixed(0)}%</td>
                        <td>{row.pointsFor}</td>
                        <td>{row.pointsAgainst}</td>
                        <td>{row.differential}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>Session Summary</h3>
              <p>Match results by court for a selected play date.</p>
            </div>
            {sessionDates.length > 0 ? (
              <>
                <div className="session-picker">
                  <span>Session date:</span>
                  <select
                    id="session-date-select"
                    className="session-picker-select"
                    value={selectedDate}
                    onChange={(event) => setSelectedDate(event.target.value)}
                  >
                    {sessionDates.map((date) => (
                      <option key={date} value={date}>{date}</option>
                    ))}
                  </select>
                </div>
                {sessionLoading ? (
                  <p>Loading session data...</p>
                ) : sessionData.length === 0 ? (
                  <p>No match data for this date.</p>
                ) : (
                  sessionData.map((court) => (
                    <div key={court.courtId} style={{ marginBottom: "1.5rem" }}>
                      {court.doubles.length > 0 && (
                        <div style={{ marginBottom: "0.75rem" }}>
                          <h4 style={{ marginBottom: "0.5rem" }}>{court.courtName} — Doubles</h4>
                          <div className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Team</th>
                                  <th>GP</th>
                                  <th>W</th>
                                  <th>L</th>
                                  <th>Win %</th>
                                  <th>PF</th>
                                  <th>PA</th>
                                  <th>Diff</th>
                                </tr>
                              </thead>
                              <tbody>
                                {court.doubles.map((row) => (
                                  <tr key={row.teamId}>
                                    <td><TeamLink id={row.teamId} name={row.teamName} /></td>
                                    <td>{row.gamesPlayed}</td>
                                    <td>{row.wins}</td>
                                    <td>{row.losses}</td>
                                    <td>{(row.winRate * 100).toFixed(0)}%</td>
                                    <td>{row.pointsFor}</td>
                                    <td>{row.pointsAgainst}</td>
                                    <td>{row.differential}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {court.ladder.length > 0 && (
                        <div>
                          <h4 style={{ marginBottom: "0.5rem" }}>{court.courtName} — Ladder</h4>
                          <div className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Player</th>
                                  <th>GP</th>
                                  <th>W</th>
                                  <th>L</th>
                                  <th>Win %</th>
                                  <th>PF</th>
                                  <th>PA</th>
                                  <th>Diff</th>
                                </tr>
                              </thead>
                              <tbody>
                                {court.ladder.map((row) => (
                                  <tr key={row.playerId}>
                                    <td><PlayerLink id={row.playerId} name={row.playerName} /></td>
                                    <td>{row.gamesPlayed}</td>
                                    <td>{row.wins}</td>
                                    <td>{row.losses}</td>
                                    <td>{(row.winRate * 100).toFixed(0)}%</td>
                                    <td>{row.pointsFor}</td>
                                    <td>{row.pointsAgainst}</td>
                                    <td>{row.differential}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </>
            ) : (
              <p>{loading ? "Loading..." : "No sessions recorded yet."}</p>
            )}
          </section>

          <section className="panel match-log">
            <div className="panel-header">
              <h3>Recent Matches</h3>
              <p>Latest 10 match entries.</p>
            </div>
            <ul>
              {recentMatches.map((match) => (
                <li key={match.id}>
                  <span>{match.date}</span>
                  <strong>
                    <TeamLink id={teamIdByName.get(match.teamA) ?? null} name={match.teamA} />
                  </strong>
                  <em>{match.scoreA}</em>
                  <em>{match.scoreB}</em>
                  <strong>
                    <TeamLink id={teamIdByName.get(match.teamB) ?? null} name={match.teamB} />
                  </strong>
                </li>
              ))}
            </ul>
          </section>

          {import.meta.env.DEV && (
            <footer className="panel admin-entry">
              <a className="admin-link" href="/admin">Admin</a>
            </footer>
          )}
        </>
      )}

      {showLoadingOverlay ? (
        <div className="loading-overlay" role="status" aria-live="polite" aria-busy="true">
          <div className="loading-overlay-card">
            <div className="loading-spinner" />
            <p>Loading latest league stats...</p>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
