import { useCallback, useEffect, useMemo, useState } from "react";
import { LeagueStatRow, PublicMatch, SessionCourtEntry, StatsRow } from "./types";
import { statsUrl, fetchStats } from "./dataSource";
import { stripBase, withBase } from "./basePath";

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

const statBody = (acc: StatAccumulator) => ({
  gamesPlayed: acc.gamesPlayed,
  wins: acc.wins,
  losses: acc.losses,
  pointsFor: acc.pointsFor,
  pointsAgainst: acc.pointsAgainst,
  differential: acc.pointsFor - acc.pointsAgainst,
  winRate: acc.gamesPlayed === 0 ? 0 : acc.wins / acc.gamesPlayed
});

const toStatsRow = (id: string, name: string, acc: StatAccumulator): StatsRow => ({
  id,
  name,
  ...statBody(acc)
});

/** Picker value for the cross-league view. Never a real league id. */
const ALL_LEAGUES = "__all__";

// "ORDER BY wins DESC, winRate DESC, differential DESC" — the standings order
// carried over from the original SQL.
const byWinsDesc = (a: { wins: number; winRate: number; differential: number },
                    b: { wins: number; winRate: number; differential: number }) => (
  b.wins - a.wins || b.winRate - a.winRate || b.differential - a.differential
);

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
  withBase(`/player/${gPlayerSlugById.get(id) ?? encodeURIComponent(id)}`);
const getTeamRoute = (id: string | null) =>
  id ? withBase(`/team/${gTeamSlugById.get(id) ?? encodeURIComponent(id)}`) : null;

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

  const courtOptions = useMemo(() => {
    const courts = new Map<string, string>();
    for (const match of teamMatches) {
      if (match.courtId) courts.set(match.courtId, match.courtName);
    }
    return Array.from(courts.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [teamMatches]);

  const [leagueFilter, setLeagueFilter] = useState("");
  const [opponentFilter, setOpponentFilter] = useState("");
  const [playerFilter, setPlayerFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [courtFilter, setCourtFilter] = useState("");

  const filteredMatches = useMemo(
    () => teamMatches.filter((match) => {
      if (leagueFilter && match.leagueId !== leagueFilter) return false;
      if (dateFilter && match.date !== dateFilter) return false;
      if (courtFilter && match.courtId !== courtFilter) return false;

      const opponentId = match.teamAId === teamId ? match.teamBId : match.teamAId;
      if (opponentFilter && opponentId !== opponentFilter) return false;

      if (playerFilter && !match.participants.some((participant) => participant.playerId === playerFilter)) return false;
      return true;
    }),
    [courtFilter, dateFilter, leagueFilter, opponentFilter, playerFilter, teamId, teamMatches]
  );

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Team View</p>
        <h1>{teamName}</h1>
        <p>League and court performance, player contributions, opponents, and full match history.</p>
        <p><a className="hero-link" href={withBase("/")}>Back to main dashboard</a></p>
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
                    <th title="Games Played">GP</th>
                    <th title="Wins">W</th>
                    <th title="Losses">L</th>
                    <th title="Win Percentage">Win %</th>
                    <th title="Points For">PF</th>
                    <th title="Points Against">PA</th>
                    <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                  <th title="Games Played">GP</th>
                  <th title="Wins">W</th>
                  <th title="Losses">L</th>
                  <th title="Win Percentage">Win %</th>
                  <th title="Points For">PF</th>
                  <th title="Points Against">PA</th>
                  <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                  <th title="Games Played">GP</th>
                  <th title="Wins">W</th>
                  <th title="Losses">L</th>
                  <th title="Win Percentage">Win %</th>
                  <th title="Points For">PF</th>
                  <th title="Points Against">PA</th>
                  <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                <th>Result</th>
                <th>Players (All 4)</th>
              </tr>
              <tr className="match-filter-row">
                <th>
                  <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
                    <option value="">All dates</option>
                    {dateOptions.map((date) => (
                      <option key={date} value={date}>{date}</option>
                    ))}
                  </select>
                </th>
                <th>
                  <select value={leagueFilter} onChange={(event) => setLeagueFilter(event.target.value)}>
                    <option value="">All leagues</option>
                    {leagueOptions.map((league) => (
                      <option key={league.id} value={league.id}>{league.name}</option>
                    ))}
                  </select>
                </th>
                <th>
                  <select value={courtFilter} onChange={(event) => setCourtFilter(event.target.value)}>
                    <option value="">No Filter</option>
                    {courtOptions.map((court) => (
                      <option key={court.id} value={court.id}>{court.name}</option>
                    ))}
                  </select>
                </th>
                <th>
                  <select value={opponentFilter} onChange={(event) => setOpponentFilter(event.target.value)}>
                    <option value="">All teams</option>
                    {opponentOptions.map((team) => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ))}
                  </select>
                </th>
                <th />
                <th />
                <th>
                  <select value={playerFilter} onChange={(event) => setPlayerFilter(event.target.value)}>
                    <option value="">All players</option>
                    {playerOptions.map((player) => (
                      <option key={player.id} value={player.id}>{player.name}</option>
                    ))}
                  </select>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredMatches.map((match) => {
                const opponentId = match.teamAId === teamId ? match.teamBId : match.teamAId;
                const opponentName = match.teamAId === teamId ? match.teamBName : match.teamAName;
                const players = getAllMatchPlayerNames(match);
                const onSideA = match.teamAId === teamId;
                const scoreText = onSideA
                  ? `${match.scoreA}-${match.scoreB}`
                  : `${match.scoreB}-${match.scoreA}`;
                const isWin = onSideA ? match.scoreA > match.scoreB : match.scoreB > match.scoreA;

                return (
                  <tr key={match.id}>
                    <td>{match.date}</td>
                    <td>{match.leagueName}</td>
                    <td>{match.courtName}</td>
                    <td><TeamLink id={opponentId} name={opponentName} /></td>
                    <td>{scoreText}</td>
                    <td style={{ color: isWin ? "#2a7a3b" : "#9a2f2f", fontWeight: 600 }}>{isWin ? "Win" : "Loss"}</td>
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

  const courtOptions = useMemo(() => {
    const courts = new Map<string, string>();
    for (const match of playerMatches) {
      if (match.courtId) courts.set(match.courtId, match.courtName);
    }
    return Array.from(courts.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [playerMatches]);

  const [leagueFilter, setLeagueFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [playerFilter, setPlayerFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [courtFilter, setCourtFilter] = useState("");

  const filteredMatches = useMemo(
    () => playerMatches.filter((match) => {
      if (leagueFilter && match.leagueId !== leagueFilter) return false;
      if (dateFilter && match.date !== dateFilter) return false;
      if (courtFilter && match.courtId !== courtFilter) return false;

      const teamMeta = getPlayerTeamKeyAndLabel(match, playerId);
      if (teamFilter && teamMeta.key !== teamFilter) return false;

      if (playerFilter && !match.participants.some((participant) => participant.playerId === playerFilter)) return false;
      return true;
    }),
    [courtFilter, dateFilter, leagueFilter, playerFilter, playerId, playerMatches, teamFilter]
  );

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Player View</p>
        <h1>{playerName}</h1>
        <p>League/team/court performance, head-to-head trends, and complete match history.</p>
        <p><a className="hero-link" href={withBase("/")}>Back to main dashboard</a></p>
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
                    <th title="Games Played">GP</th>
                    <th title="Wins">W</th>
                    <th title="Losses">L</th>
                    <th title="Win Percentage">Win %</th>
                    <th title="Points For">PF</th>
                    <th title="Points Against">PA</th>
                    <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                        <th title="Games Played">GP</th>
                        <th title="Wins">W</th>
                        <th title="Losses">L</th>
                        <th title="Win Percentage">Win %</th>
                        <th title="Points For">PF</th>
                        <th title="Points Against">PA</th>
                        <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                <th title="Games Played">GP</th>
                <th title="Wins">W</th>
                <th title="Losses">L</th>
                <th title="Win Percentage">Win %</th>
                <th title="Points For">PF</th>
                <th title="Points Against">PA</th>
                <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                <th>Result</th>
                <th>Players</th>
              </tr>
              <tr className="match-filter-row">
                <th>
                  <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
                    <option value="">All dates</option>
                    {dateOptions.map((date) => (
                      <option key={date} value={date}>{date}</option>
                    ))}
                  </select>
                </th>
                <th>
                  <select value={leagueFilter} onChange={(event) => setLeagueFilter(event.target.value)}>
                    <option value="">All leagues</option>
                    {leagueOptions.map((league) => (
                      <option key={league.id} value={league.id}>{league.name}</option>
                    ))}
                  </select>
                </th>
                <th>
                  <select value={courtFilter} onChange={(event) => setCourtFilter(event.target.value)}>
                    <option value="">No Filter</option>
                    {courtOptions.map((court) => (
                      <option key={court.id} value={court.id}>{court.name}</option>
                    ))}
                  </select>
                </th>
                <th>
                  <select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}>
                    <option value="">All teams</option>
                    {teamOptions.map((team) => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ))}
                  </select>
                </th>
                <th />
                <th />
                <th />
                <th>
                  <select value={playerFilter} onChange={(event) => setPlayerFilter(event.target.value)}>
                    <option value="">All players</option>
                    {relatedPlayerOptions.map((player) => (
                      <option key={player.id} value={player.id}>{player.name}</option>
                    ))}
                  </select>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredMatches.map((match) => {
                const side = getPlayerSideForMatch(match, playerId);
                const teamMeta = getPlayerTeamKeyAndLabel(match, playerId);
                const opponentTeam = getOpponentTeamForPlayer(match, playerId);
                const scoreText = side === "A" ? `${match.scoreA}-${match.scoreB}` : `${match.scoreB}-${match.scoreA}`;
                const isWin = side === "A" ? match.scoreA > match.scoreB : match.scoreB > match.scoreA;
                const playerNames = match.participants.map((participant) => participant.playerName).join(", ");

                return (
                  <tr key={match.id}>
                    <td>{match.date}</td>
                    <td>{match.leagueName}</td>
                    <td>{match.courtName}</td>
                    <td>{teamMeta.key === "ladder" ? teamMeta.label : <TeamLink id={teamMeta.key} name={teamMeta.label} />}</td>
                    <td>{opponentTeam.id ? <TeamLink id={opponentTeam.id} name={opponentTeam.name} /> : opponentTeam.name}</td>
                    <td>{scoreText}</td>
                    <td style={{ color: isWin ? "#2a7a3b" : "#9a2f2f", fontWeight: 600 }}>{isWin ? "Win" : "Loss"}</td>
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

  const [publicMatches, setPublicMatches] = useState<PublicMatch[]>([]);
  const [leagues, setLeagues] = useState<LeagueStatRow[]>([]);

  const [selectedLeagueId, setSelectedLeagueId] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>("");

  const [teamCourtFilter, setTeamCourtFilter] = useState<string>("");

  // Everything on this page is derived from the full match list, so a league
  // filter is a plain array filter rather than another round of fetches. The
  // pre-computed players/teams/session tables are league-wide by construction
  // and would ignore the picker.
  const loadStats = useCallback(async () => {
    const [pmRes, lgRes] = await Promise.all([
      fetchStats(statsUrl("matches-full")),
      fetchStats(statsUrl("leagues"))
    ]);

    if (!pmRes.ok || !lgRes.ok) {
      throw new Error("Failed to load stats");
    }

    const [pm, lg] = await Promise.all([
      pmRes.json() as Promise<PublicMatch[]>,
      lgRes.json() as Promise<LeagueStatRow[]>
    ]);

    setPublicMatches(pm);
    setLeagues(lg);
  }, []);

  useEffect(() => {
    setLoading(true);
    setApiError(null);
    loadStats()
      .catch(() => setApiError("Could not reach the API. Verify deployment and SQL connection settings."))
      .finally(() => setLoading(false));
  }, [loadStats]);

  // Newest start date first. leagues.json already arrives in this order; the
  // sort keeps the picker correct if that ever changes.
  const leagueOptions = useMemo(
    () => [...leagues].sort(
      (a, b) => b.startDate.localeCompare(a.startDate) || a.name.localeCompare(b.name)
    ),
    [leagues]
  );

  // Default to the newest league once the list arrives. An explicit All
  // selection survives a refresh; anything else falls back to the newest.
  useEffect(() => {
    if (leagueOptions.length === 0) return;
    setSelectedLeagueId((prev) =>
      prev === ALL_LEAGUES || leagueOptions.some((l) => l.id === prev)
        ? prev
        : leagueOptions[0].id
    );
  }, [leagueOptions]);

  // Null for All Leagues — there is no single league message to show.
  const selectedLeague = useMemo(
    () => leagueOptions.find((l) => l.id === selectedLeagueId) ?? null,
    [leagueOptions, selectedLeagueId]
  );

  // The slice of matches every stat on this page is built from. Empty until a
  // selection exists, so the first paint never shows unfiltered totals.
  const leagueMatches = useMemo(() => {
    if (selectedLeagueId === ALL_LEAGUES) return publicMatches;
    if (!selectedLeagueId) return [];
    return publicMatches.filter((m) => m.leagueId === selectedLeagueId);
  }, [publicMatches, selectedLeagueId]);

  const playerStats = useMemo(() => {
    const accs = new Map<string, { name: string; acc: StatAccumulator }>();
    for (const m of leagueMatches) {
      for (const part of m.participants) {
        const entry = accs.get(part.playerId)
          ?? { name: part.playerName, acc: createAccumulator() };
        addGame(
          entry.acc,
          part.teamSide === "A" ? m.scoreA : m.scoreB,
          part.teamSide === "A" ? m.scoreB : m.scoreA
        );
        accs.set(part.playerId, entry);
      }
    }
    return [...accs.entries()]
      .map(([id, entry]) => toStatsRow(id, entry.name, entry.acc))
      .sort(byWinsDesc);
  }, [leagueMatches]);

  const teamStats = useMemo(() => {
    const accs = new Map<string, { name: string; acc: StatAccumulator }>();
    for (const m of leagueMatches) {
      if (m.gameType !== "Doubles" || !m.teamAId || !m.teamBId) continue;
      const bump = (id: string, name: string, pf: number, pa: number) => {
        const entry = accs.get(id) ?? { name, acc: createAccumulator() };
        addGame(entry.acc, pf, pa);
        accs.set(id, entry);
      };
      bump(m.teamAId, m.teamAName, m.scoreA, m.scoreB);
      bump(m.teamBId, m.teamBName, m.scoreB, m.scoreA);
    }
    return [...accs.entries()]
      .map(([id, entry]) => toStatsRow(id, entry.name, entry.acc))
      .sort(byWinsDesc);
  }, [leagueMatches]);

  const sessionDates = useMemo(
    () => [...new Set(leagueMatches.map((m) => m.date))].sort((a, b) => b.localeCompare(a)),
    [leagueMatches]
  );

  // Keep the session picker on a date the selected league actually played.
  useEffect(() => {
    setSelectedDate((prev) => (prev && sessionDates.includes(prev) ? prev : sessionDates[0] ?? ""));
  }, [sessionDates]);

  // Per-court team (Doubles) and player (Ladder) stats for the selected date.
  // Only matches with a court assigned are counted.
  const sessionData = useMemo<SessionCourtEntry[]>(() => {
    if (!selectedDate) return [];
    const courts = new Map<string, {
      courtName: string;
      doubles: Map<string, { name: string; acc: StatAccumulator }>;
      ladder: Map<string, { name: string; acc: StatAccumulator }>;
    }>();
    const ensure = (courtId: string, courtName: string) => {
      const existing = courts.get(courtId);
      if (existing) return existing;
      const created = { courtName, doubles: new Map(), ladder: new Map() };
      courts.set(courtId, created);
      return created;
    };

    for (const m of leagueMatches) {
      if (m.date !== selectedDate || !m.courtId) continue;

      if (m.gameType === "Doubles" && m.teamAId && m.teamBId) {
        const court = ensure(m.courtId, m.courtName);
        const bump = (id: string, name: string, pf: number, pa: number) => {
          const entry = court.doubles.get(id) ?? { name, acc: createAccumulator() };
          addGame(entry.acc, pf, pa);
          court.doubles.set(id, entry);
        };
        bump(m.teamAId, m.teamAName, m.scoreA, m.scoreB);
        bump(m.teamBId, m.teamBName, m.scoreB, m.scoreA);
      } else if (m.gameType === "Ladder") {
        const court = ensure(m.courtId, m.courtName);
        for (const part of m.participants) {
          const entry = court.ladder.get(part.playerId)
            ?? { name: part.playerName, acc: createAccumulator() };
          addGame(
            entry.acc,
            part.teamSide === "A" ? m.scoreA : m.scoreB,
            part.teamSide === "A" ? m.scoreB : m.scoreA
          );
          court.ladder.set(part.playerId, entry);
        }
      }
    }

    return [...courts.entries()]
      .map(([courtId, court]) => ({
        courtId,
        courtName: court.courtName,
        doubles: [...court.doubles.entries()]
          .map(([teamId, e]) => ({ teamId, teamName: e.name, ...statBody(e.acc) }))
          .sort(byWinsDesc),
        ladder: [...court.ladder.entries()]
          .map(([playerId, e]) => ({ playerId, playerName: e.name, ...statBody(e.acc) }))
          .sort(byWinsDesc)
      }))
      .sort((a, b) => a.courtName.localeCompare(b.courtName));
  }, [leagueMatches, selectedDate]);

  // leagueMatches keeps the export order: match date DESC, then entry order.
  const recentMatches = useMemo(() => leagueMatches.slice(0, 10), [leagueMatches]);

  const totalPlayers = playerStats.length;
  const totalTeams = teamStats.length;
  const totalSessions = sessionDates.length;

  // Name lookups span every league — the team and player detail pages they feed
  // are deliberately not filtered by the picker.
  const teamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const match of publicMatches) {
      if (match.teamAId) map.set(match.teamAId, match.teamAName);
      if (match.teamBId) map.set(match.teamBId, match.teamBName);
    }
    return map;
  }, [publicMatches]);

  const playerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const match of publicMatches) {
      for (const participant of match.participants) {
        map.set(participant.playerId, participant.playerName);
      }
    }
    return map;
  }, [publicMatches]);

  // Courts that appear in at least one match of the selected league.
  const courtOptions = useMemo(() => {
    const courts = new Map<string, string>(); // id → name
    for (const m of leagueMatches) {
      if (m.courtId && m.courtName) courts.set(m.courtId, m.courtName);
    }
    return [...courts.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [leagueMatches]);

  // Drop the court filter when it names a court the selected league never used.
  useEffect(() => {
    setTeamCourtFilter((prev) => (prev && courtOptions.some((c) => c.id === prev) ? prev : ""));
  }, [courtOptions]);

  // Team stats re-computed when a court filter is active.
  const filteredTeamStats = useMemo(() => {
    if (!teamCourtFilter) return teamStats;
    const accs = new Map<string, { name: string; acc: StatAccumulator }>();
    for (const m of leagueMatches) {
      if (m.gameType !== "Doubles" || !m.teamAId || !m.teamBId) continue;
      if (m.courtId !== teamCourtFilter) continue;
      const bump = (id: string, name: string, pf: number, pa: number) => {
        const entry = accs.get(id) ?? { name, acc: createAccumulator() };
        addGame(entry.acc, pf, pa);
        accs.set(id, entry);
      };
      bump(m.teamAId, m.teamAName, m.scoreA, m.scoreB);
      bump(m.teamBId, m.teamBName, m.scoreB, m.scoreA);
    }
    return [...accs.entries()]
      .map(([id, entry]) => toStatsRow(id, entry.name, entry.acc))
      .sort(byWinsDesc);
  }, [teamCourtFilter, leagueMatches, teamStats]);

  // Refresh slug maps from the current data on every render. Both inputs are
  // Maps derived via useMemo so this is a pure derivation, not a side-effect.
  if (playerNameById.size > 0) {
    [gPlayerSlugById, gPlayerBySlug] = buildSlugMap(playerNameById);
  }
  if (teamNameById.size > 0) {
    [gTeamSlugById, gTeamBySlug] = buildSlugMap(teamNameById);
  }

  const path = stripBase(window.location.pathname).replace(/\/+$/, "") || "/";
  const teamPathMatch = path.match(/^\/team\/([^/]+)$/i);
  const playerPathMatch = path.match(/^\/player\/([^/]+)$/i);
  const teamRouteSlug = teamPathMatch ? decodePathSegment(teamPathMatch[1]) : "";
  const playerRouteSlug = playerPathMatch ? decodePathSegment(playerPathMatch[1]) : "";
  // Resolve slug → ID (falls back to treating the segment as a raw ID for
  // any bookmarks that pre-date this change).
  const teamRouteId = teamRouteSlug ? (gTeamBySlug.get(teamRouteSlug) ?? "") : "";
  const playerRouteId = playerRouteSlug ? (gPlayerBySlug.get(playerRouteSlug) ?? "") : "";
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
              <img className="club-logo" src={withBase("/brand/HW PickleBall Logo.png")} alt="Hiram Walker Pickleball Club logo" />
              <div>
                <p className="eyebrow">Hiram Walker Pickleball League</p>
                <h1>League Statistics Portal</h1>
              </div>
            </div>
            <p>View live league, team, player, and recent match statistics. Click any team or player name for detail pages.</p>

            {leagueOptions.length > 0 ? (
              <div className="league-picker">
                <label htmlFor="league-select">League</label>
                <select
                  id="league-select"
                  className="league-picker-select"
                  value={selectedLeagueId}
                  onChange={(event) => setSelectedLeagueId(event.target.value)}
                >
                  <option value={ALL_LEAGUES}>All Leagues</option>
                  {leagueOptions.map((league) => (
                    <option key={league.id} value={league.id}>{league.name}</option>
                  ))}
                </select>
              </div>
            ) : null}

            {selectedLeague?.messageHtml?.trim() ? (
              // Authored by the league admin in the local admin panel — not
              // user input, and baked into the static snapshot at export time.
              <div
                className="league-message"
                dangerouslySetInnerHTML={{ __html: selectedLeague.messageHtml }}
              />
            ) : null}

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
              </div>
              <div className="filter-row">
                <label>
                  Court
                  <select value={teamCourtFilter} onChange={(e) => setTeamCourtFilter(e.target.value)}>
                    <option value="">No Filter</option>
                    {courtOptions.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th title="Games Played">GP</th>
                      <th title="Wins">W</th>
                      <th title="Losses">L</th>
                      <th title="Win Percentage">Win %</th>
                      <th title="Points For">PF</th>
                      <th title="Points Against">PA</th>
                      <th title="Point Differential (Points For minus Points Against)">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTeamStats.map((row) => (
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
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th title="Games Played">GP</th>
                      <th title="Wins">W</th>
                      <th title="Losses">L</th>
                      <th title="Win Percentage">Win %</th>
                      <th title="Points For">PF</th>
                      <th title="Points Against">PA</th>
                      <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                {sessionData.length === 0 ? (
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
                                  <th title="Games Played">GP</th>
                                  <th title="Wins">W</th>
                                  <th title="Losses">L</th>
                                  <th title="Win Percentage">Win %</th>
                                  <th title="Points For">PF</th>
                                  <th title="Points Against">PA</th>
                                  <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
                                  <th title="Games Played">GP</th>
                                  <th title="Wins">W</th>
                                  <th title="Losses">L</th>
                                  <th title="Win Percentage">Win %</th>
                                  <th title="Points For">PF</th>
                                  <th title="Points Against">PA</th>
                                  <th title="Point Differential (Points For minus Points Against)">Diff</th>
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
            <div className="match-log-header">
              <span>Date</span>
              <span>Team</span>
              <span style={{ gridColumn: "3 / 5", textAlign: "center" }}>Score</span>
              <span>Team</span>
            </div>
            <ul>
              {recentMatches.map((match) => (
                <li key={match.id}>
                  <span>{match.date}</span>
                  <strong>
                    <TeamLink id={match.teamAId} name={match.teamAName} />
                  </strong>
                  <em>{match.scoreA}</em>
                  <em>{match.scoreB}</em>
                  <strong>
                    <TeamLink id={match.teamBId} name={match.teamBName} />
                  </strong>
                </li>
              ))}
            </ul>
          </section>

          <footer className="panel admin-entry">
            {import.meta.env.DEV && (
              <>
                <a className="admin-link" href={withBase("/admin")}>Admin</a>
                <span className="admin-entry-sep" aria-hidden="true">·</span>
              </>
            )}
            <a className="admin-link" href="mailto:scott.jahn@gmail.com">Contact</a>
            <span className="admin-entry-sep" aria-hidden="true">·</span>
            <a className="admin-link" href="https://github.com/scottjahn/hwpl-manager/issues">Feedback</a>
          </footer>
        </>
      )}

      {loading ? (
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
