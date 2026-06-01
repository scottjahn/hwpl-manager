import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Court, League, Player, Team } from "./types";

interface AuthMeClaim {
  typ?: string;
  type?: string;
  val?: string;
  value?: string;
}

interface AuthMePrincipal {
  userId?: string;
  claims?: AuthMeClaim[];
}

interface AuthMeLegacyEntry {
  user_id?: string;
  user_claims?: AuthMeClaim[];
}

interface AuthMeCurrentEntry {
  clientPrincipal?: AuthMePrincipal;
}

interface DebugAuthResponse {
  isAuthenticated?: boolean;
  isAdmin?: boolean;
  objectId?: string;
  candidateIds?: string[];
  principalName?: string;
  roles?: string[];
  headerPresence?: {
    hasClientPrincipal?: boolean;
    hasClientPrincipalId?: boolean;
    hasClientPrincipalName?: boolean;
  };
}

interface ManagedMatch {
  id: string;
  leagueId: string;
  courtId: string;
  courtName: string;
  scoringType: "Sideout" | "Rally";
  gameType: "Doubles" | "Ladder";
  date: string;
  teamAId: string;
  teamBId: string;
  scoreA: number;
  scoreB: number;
  leagueName: string;
  teamAName: string;
  teamBName: string;
  teamAPlayers: [string, string];
  teamBPlayers: [string, string];
  teamAPlayerNames: [string, string];
  teamBPlayerNames: [string, string];
}

type PlayerForm = {
  firstName: string;
  lastName: string;
  duprId: string;
  defaultTeamId: string;
  isActive: boolean;
};
type TeamForm = { name: string; leagueIds: string[]; isActive: boolean };
type LeagueForm = Omit<League, "id">;
type CourtForm = Omit<Court, "id">;

interface MatchForm {
  leagueId: string;
  courtId: string;
  scoringType: "Sideout" | "Rally";
  gameType: "Doubles" | "Ladder";
  date: string;
  teamAId: string;
  teamBId: string;
  teamAPlayer1: string;
  teamAPlayer2: string;
  teamBPlayer1: string;
  teamBPlayer2: string;
  scoreA: string;
  scoreB: string;
}

interface MatchSubmitDebug {
  timestamp: string;
  phase: "requesting" | "response" | "network-error" | "refresh-success" | "refresh-failed";
  mode: "create" | "update";
  endpoint: string;
  editingMatchId: string | null;
  payload: {
    leagueId: string;
    courtId: string;
    scoringType: "Sideout" | "Rally";
    gameType: "Doubles" | "Ladder";
    date: string;
    teamAId: string | null;
    teamBId: string | null;
    teamAPlayers: string[];
    teamBPlayers: string[];
    scoreA: number;
    scoreB: number;
  };
  response?: {
    status: number;
    ok: boolean;
    rawBody: string;
    parsedBody: unknown;
  };
  error?: string;
}

interface ApiDiagnostics {
  version: string;
  timestamp: string;
}

type WidgetScope = "global" | "match" | "export" | "matches" | "players" | "teams" | "leagues" | "courts" | "assign-courts";

interface WidgetMessage {
  scope: WidgetScope;
  text: string;
  isError: boolean;
}

interface TeamToggleDebug {
  timestamp: string;
  endpoint: string;
  teamId: string;
  previousIsActive: boolean;
  payload: {
    name: string;
    isActive: boolean;
  };
  response?: {
    status: number;
    ok: boolean;
    rawBody: string;
    parsedBody: unknown;
  };
  error?: string;
}

const emptyPlayerForm: PlayerForm = {
  firstName: "",
  lastName: "",
  duprId: "",
  defaultTeamId: "",
  isActive: true
};

const emptyTeamForm: TeamForm = {
  name: "",
  leagueIds: [],
  isActive: true
};

const emptyLeagueForm: LeagueForm = {
  name: "",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  isActive: true
};

const emptyCourtForm: CourtForm = {
  name: "",
  isActive: true
};

const authFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  return fetch(input, {
    ...init,
    credentials: "include"
  });
};

const ASSIGNMENTS_STORAGE_KEY = "hwpl-admin-court-assignments-v1";
const MIN_GAMES_PER_MATCH = 1;
const MAX_GAMES_PER_MATCH = 9;
const TEAM_ORDER_PRIORITY = ["west", "middle", "east"];

type AdminView = "league-data" | "assign-courts";

interface RoundRobinRound {
  byeTeamId: string | null;
  matches: Array<[string, string]>;
}

interface RoundRobinRow {
  roundIndex: number;
  rowIndexWithinRound: number;
  matchesInRound: number;
  byeTeamId: string | null;
  teamAId: string;
  teamBId: string;
}

interface SavedCourtAssignments {
  teamToCourtId: Record<string, string>;
  gamesPerCourt: Record<string, number>;
  adminView?: AdminView;
}

const clampGamesPerMatch = (value: number) => Math.min(MAX_GAMES_PER_MATCH, Math.max(MIN_GAMES_PER_MATCH, value));

const escapeHtml = (value: string) => (
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
);

const getTeamOrderRank = (teamName: string) => {
  const normalized = teamName.trim().toLowerCase();
  const priorityIndex = TEAM_ORDER_PRIORITY.indexOf(normalized);
  return priorityIndex === -1 ? Number.POSITIVE_INFINITY : priorityIndex;
};

const reorderMatchesForFlow = (matches: Array<[string, string]>, previousPair: [string, string] | null): Array<[string, string]> => {
  if (matches.length <= 1) return matches;

  const remaining = [...matches];
  const ordered: Array<[string, string]> = [];
  const getOverlap = (pairA: [string, string], pairB: [string, string]) => {
    const setA = new Set(pairA);
    return pairB.filter((teamId) => setA.has(teamId)).length;
  };

  while (remaining.length) {
    const reference = ordered.length ? ordered[ordered.length - 1] : previousPair;
    if (!reference) {
      ordered.push(remaining.shift()!);
      continue;
    }

    let bestIndex = 0;
    let bestOverlap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const overlap = getOverlap(reference, remaining[i]);
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        bestIndex = i;
      }
      if (overlap === 0) break;
    }

    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return ordered;
};

const buildRoundRobinRows = (teamIds: string[]): RoundRobinRow[] => {
  if (teamIds.length < 2) return [];

  const BYE = "__BYE__";
  const rotation = [...teamIds];
  if (rotation.length % 2 === 1) {
    rotation.push(BYE);
  }

  const rounds: RoundRobinRound[] = [];
  const roundsCount = rotation.length - 1;

  for (let roundIndex = 0; roundIndex < roundsCount; roundIndex += 1) {
    const matches: Array<[string, string]> = [];
    let byeTeamId: string | null = null;
    const half = rotation.length / 2;

    for (let i = 0; i < half; i += 1) {
      const left = rotation[i];
      const right = rotation[rotation.length - 1 - i];

      if (left === BYE || right === BYE) {
        byeTeamId = left === BYE ? right : left;
        continue;
      }

      matches.push(roundIndex % 2 === 0 ? [left, right] : [right, left]);
    }

    rounds.push({ byeTeamId, matches });

    const fixed = rotation[0];
    const moving = rotation.slice(1);
    moving.unshift(moving.pop()!);
    rotation.splice(0, rotation.length, fixed, ...moving);
  }

  const rows: RoundRobinRow[] = [];
  let previousPair: [string, string] | null = null;

  rounds.forEach((round, roundIndex) => {
    const orderedMatches = reorderMatchesForFlow(round.matches, previousPair);
    orderedMatches.forEach((match, rowIndexWithinRound) => {
      rows.push({
        roundIndex,
        rowIndexWithinRound,
        matchesInRound: orderedMatches.length,
        byeTeamId: round.byeTeamId,
        teamAId: match[0],
        teamBId: match[1]
      });
    });
    previousPair = orderedMatches.length ? orderedMatches[orderedMatches.length - 1] : previousPair;
  });

  return rows;
};

function AdminPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [entraObjectId, setEntraObjectId] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [authDebug, setAuthDebug] = useState("");

  const [leagues, setLeagues] = useState<League[]>([]);
  const [courts, setCourts] = useState<Court[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<ManagedMatch[]>([]);

  const [playerForm, setPlayerForm] = useState<PlayerForm>({ ...emptyPlayerForm });
  const [teamForm, setTeamForm] = useState<TeamForm>({ ...emptyTeamForm });
  const [leagueForm, setLeagueForm] = useState<LeagueForm>({ ...emptyLeagueForm });
  const [courtForm, setCourtForm] = useState<CourtForm>({ ...emptyCourtForm });

  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const editingTeamIdRef = useRef<string | null>(null);
  const [editingLeagueId, setEditingLeagueId] = useState<string | null>(null);
  const [editingCourtId, setEditingCourtId] = useState<string | null>(null);
  const [editingMatchId, setEditingMatchId] = useState<string | null>(null);
  const matchFormRef = useRef<HTMLElement>(null);

  const [matchForm, setMatchForm] = useState<MatchForm>({
    leagueId: "",
    courtId: "",
    scoringType: "Sideout",
    gameType: "Doubles",
    date: new Date().toISOString().slice(0, 10),
    teamAId: "",
    teamBId: "",
    teamAPlayer1: "",
    teamAPlayer2: "",
    teamBPlayer1: "",
    teamBPlayer2: "",
    scoreA: "",
    scoreB: ""
  });

  const [matchError, setMatchError] = useState("");
  const [matchSuccess, setMatchSuccess] = useState("");
  const [isSavingMatch, setIsSavingMatch] = useState(false);
  const [matchTeamFilterId, setMatchTeamFilterId] = useState("");
  const [matchPlayerFilterId, setMatchPlayerFilterId] = useState("");
  const [matchDateFilter, setMatchDateFilter] = useState("");
  const [lastMatchSubmitDebug, setLastMatchSubmitDebug] = useState<MatchSubmitDebug | null>(null);
  const [lastTeamToggleDebug, setLastTeamToggleDebug] = useState<TeamToggleDebug | null>(null);
  const [apiDiagnostics, setApiDiagnostics] = useState<ApiDiagnostics | null>(null);
  const [widgetMessage, setWidgetMessage] = useState<WidgetMessage | null>(null);
  const [csvDate, setCsvDate] = useState("");
  const [matchDates, setMatchDates] = useState<string[]>([]);
  const [adminApiBase, setAdminApiBase] = useState("/api/ops");
  const [adminView, setAdminView] = useState<AdminView>("league-data");
  const [teamToCourtId, setTeamToCourtId] = useState<Record<string, string>>({});
  const [gamesPerCourt, setGamesPerCourt] = useState<Record<string, number>>({});
  const [draggedTeamId, setDraggedTeamId] = useState<string | null>(null);

  const showWidgetMessage = useCallback((scope: WidgetScope, text: string, isError = false) => {
    setWidgetMessage({ scope, text, isError });
  }, []);

  const renderWidgetMessage = (scope: WidgetScope) => {
    if (!widgetMessage || widgetMessage.scope !== scope) {
      return null;
    }

    return (
      <p
        className={widgetMessage.isError ? "form-error" : "status-msg"}
        style={{ fontSize: "1rem", padding: "0.75rem", marginBottom: "0.5rem" }}
      >
        {widgetMessage.text}
      </p>
    );
  };

  useEffect(() => { editingTeamIdRef.current = editingTeamId; }, [editingTeamId]);

  const activeLeagues = useMemo(() => leagues.filter((league) => league.isActive), [leagues]);
  const activeCourts = useMemo(() => courts.filter((court) => court.isActive), [courts]);
  const activeTeams = useMemo(() => teams.filter((team) => team.isActive), [teams]);
  const activePlayers = useMemo(() => players.filter((player) => player.isActive), [players]);
  const teamNameById = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);
  const orderedActiveCourts = useMemo(
    () => activeCourts
      .slice()
      .sort((a, b) => {
        const rankDelta = getTeamOrderRank(a.name) - getTeamOrderRank(b.name);
        if (rankDelta !== 0) return rankDelta;
        return a.name.localeCompare(b.name);
      }),
    [activeCourts]
  );
  const orderedActiveTeams = useMemo(
    () => activeTeams
      .slice()
      .sort((a, b) => {
        const rankDelta = getTeamOrderRank(a.name) - getTeamOrderRank(b.name);
        if (rankDelta !== 0) return rankDelta;
        return a.name.localeCompare(b.name);
      }),
    [activeTeams]
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ASSIGNMENTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SavedCourtAssignments>;
      if (parsed.teamToCourtId && typeof parsed.teamToCourtId === "object") {
        setTeamToCourtId(parsed.teamToCourtId as Record<string, string>);
      }
      if (parsed.gamesPerCourt && typeof parsed.gamesPerCourt === "object") {
        const normalized: Record<string, number> = {};
        Object.entries(parsed.gamesPerCourt).forEach(([courtId, games]) => {
          const numericGames = Number(games);
          if (!Number.isNaN(numericGames)) {
            normalized[courtId] = clampGamesPerMatch(Math.round(numericGames));
          }
        });
        setGamesPerCourt(normalized);
      }
      if (parsed.adminView === "assign-courts" || parsed.adminView === "league-data") {
        setAdminView(parsed.adminView);
      }
    } catch {
      // Keep defaults if local storage is unavailable or malformed.
    }
  }, []);

  useEffect(() => {
    // Don't prune while data is still loading — an empty list here means "not
    // fetched yet", not "no active teams/courts", and pruning against empty
    // sets would wipe every assignment restored from localStorage.
    if (activeCourts.length === 0 || activeTeams.length === 0) return;

    const activeTeamIds = new Set(activeTeams.map((team) => team.id));
    const activeCourtIds = new Set(activeCourts.map((court) => court.id));

    setTeamToCourtId((prev) => {
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([teamId, courtId]) => {
        if (activeTeamIds.has(teamId) && activeCourtIds.has(courtId)) {
          next[teamId] = courtId;
        }
      });
      return next;
    });

    setGamesPerCourt((prev) => {
      const next: Record<string, number> = {};
      activeCourts.forEach((court) => {
        next[court.id] = clampGamesPerMatch(prev[court.id] ?? 2);
      });
      return next;
    });
  }, [activeCourts, activeTeams]);

  useEffect(() => {
    try {
      const payload: SavedCourtAssignments = { teamToCourtId, gamesPerCourt, adminView };
      window.localStorage.setItem(ASSIGNMENTS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Saving assignments is best-effort.
    }
  }, [adminView, gamesPerCourt, teamToCourtId]);

  // Match form lists: active items plus any currently-referenced inactive item so the select always renders its value.
  const matchFormLeagues = useMemo(() => {
    const list = [...activeLeagues];
    if (matchForm.leagueId && !list.some((l) => l.id === matchForm.leagueId)) {
      const found = leagues.find((l) => l.id === matchForm.leagueId);
      if (found) list.unshift(found);
    }
    return list;
  }, [activeLeagues, leagues, matchForm.leagueId]);

  const matchFormCourts = useMemo(() => {
    const list = [...activeCourts];
    if (matchForm.courtId && !list.some((c) => c.id === matchForm.courtId)) {
      const found = courts.find((c) => c.id === matchForm.courtId);
      if (found) list.unshift(found);
    }
    return list;
  }, [activeCourts, courts, matchForm.courtId]);

  const matchFormTeams = useMemo(() => {
    const list = [...activeTeams];
    for (const id of [matchForm.teamAId, matchForm.teamBId]) {
      if (id && !list.some((t) => t.id === id)) {
        const found = teams.find((t) => t.id === id);
        if (found) list.push(found);
      }
    }
    return list;
  }, [activeTeams, teams, matchForm.teamAId, matchForm.teamBId]);

  const matchFormPlayers = useMemo(() => {
    const list = [...activePlayers];
    for (const id of [matchForm.teamAPlayer1, matchForm.teamAPlayer2, matchForm.teamBPlayer1, matchForm.teamBPlayer2]) {
      if (id && !list.some((p) => p.id === id)) {
        const found = players.find((p) => p.id === id);
        if (found) list.push(found);
      }
    }
    return list;
  }, [activePlayers, players, matchForm.teamAPlayer1, matchForm.teamAPlayer2, matchForm.teamBPlayer1, matchForm.teamBPlayer2]);

  const getAvailablePlayersForSlot = (slot: "teamAPlayer1" | "teamAPlayer2" | "teamBPlayer1" | "teamBPlayer2") => {
    const selected = {
      teamAPlayer1: matchForm.teamAPlayer1,
      teamAPlayer2: matchForm.teamAPlayer2,
      teamBPlayer1: matchForm.teamBPlayer1,
      teamBPlayer2: matchForm.teamBPlayer2
    };

    const taken = new Set(
      Object.entries(selected)
        .filter(([key, value]) => key !== slot && Boolean(value))
        .map(([, value]) => value)
    );

    return matchFormPlayers.filter((player) => !taken.has(player.id) || player.id === selected[slot]);
  };

  const getPreferredPlayerPairForTeam = (teamId: string, excludedIds: string[]): [string, string] => {
    const excluded = new Set(excludedIds.filter(Boolean));
    const teamDefaults = activePlayers
      .filter((player) => player.defaultTeamId === teamId)
      .map((player) => player.id)
      .filter((id) => !excluded.has(id));
    const fallback = activePlayers
      .map((player) => player.id)
      .filter((id) => !excluded.has(id) && !teamDefaults.includes(id));
    const candidates = [...teamDefaults, ...fallback];
    return [candidates[0] ?? "", candidates[1] ?? ""];
  };

  const formatLeagueDates = (league: Pick<League, "startDate" | "endDate">) => `${league.startDate} to ${league.endDate}`;

  const matchDateOptions = useMemo(() => {
    const uniqueDates = new Set(matches.map((match) => match.date));
    return Array.from(uniqueDates).sort((a, b) => b.localeCompare(a));
  }, [matches]);

  const filteredMatches = useMemo(() => {
    return matches.filter((match) => {
      const matchesTeam = !matchTeamFilterId
        || match.teamAId === matchTeamFilterId
        || match.teamBId === matchTeamFilterId;
      const matchesPlayer = !matchPlayerFilterId
        || match.teamAPlayers.includes(matchPlayerFilterId)
        || match.teamBPlayers.includes(matchPlayerFilterId);
      const matchesDate = !matchDateFilter || match.date === matchDateFilter;

      return matchesTeam && matchesPlayer && matchesDate;
    });
  }, [matches, matchTeamFilterId, matchPlayerFilterId, matchDateFilter]);

  const leagueNameById = useMemo(
    () => new Map(leagues.map((l) => [l.id, l.name])),
    [leagues]
  );

  const assignedTeamsByCourt = useMemo(() => {
    const grouped: Record<string, Team[]> = {};
    orderedActiveCourts.forEach((court) => {
      grouped[court.id] = [];
    });

    orderedActiveTeams.forEach((team) => {
      const assignedCourtId = teamToCourtId[team.id];
      if (assignedCourtId && grouped[assignedCourtId]) {
        grouped[assignedCourtId].push(team);
      }
    });

    return grouped;
  }, [orderedActiveCourts, orderedActiveTeams, teamToCourtId]);

  const unassignedTeams = useMemo(
    () => orderedActiveTeams.filter((team) => !teamToCourtId[team.id]),
    [orderedActiveTeams, teamToCourtId]
  );

  const onAssignTeamToCourt = (teamId: string, courtId: string) => {
    setTeamToCourtId((prev) => {
      if (!courtId) {
        const { [teamId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [teamId]: courtId };
    });
  };

  const onChangeGamesPerCourt = (courtId: string, rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10);
    const normalized = Number.isNaN(parsed) ? 2 : clampGamesPerMatch(parsed);
    setGamesPerCourt((prev) => ({ ...prev, [courtId]: normalized }));
  };

  const onClearAllAssignments = () => {
    setTeamToCourtId({});
    showWidgetMessage("assign-courts", "All court assignments were cleared.");
  };

  const onTeamDragStart = (event: DragEvent<HTMLElement>, teamId: string) => {
    setDraggedTeamId(teamId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/team-id", teamId);
  };

  const onTeamDragEnd = () => {
    setDraggedTeamId(null);
  };

  const onAllowDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
  };

  const onDropTeamToCourt = (event: DragEvent<HTMLElement>, courtId: string) => {
    event.preventDefault();
    const droppedTeamId = event.dataTransfer.getData("text/team-id") || draggedTeamId;
    if (!droppedTeamId) return;
    onAssignTeamToCourt(droppedTeamId, courtId);
    setDraggedTeamId(null);
  };

  const onDropTeamToUnassigned = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const droppedTeamId = event.dataTransfer.getData("text/team-id") || draggedTeamId;
    if (!droppedTeamId) return;
    onAssignTeamToCourt(droppedTeamId, "");
    setDraggedTeamId(null);
  };

  const openRoundRobinPrintWindow = (court: Court) => {
    const teamsForCourt = assignedTeamsByCourt[court.id] ?? [];
    if (teamsForCourt.length < 2) {
      showWidgetMessage("assign-courts", `Assign at least 2 teams to ${court.name} to generate matches.`, true);
      return;
    }

    const teamIds = teamsForCourt.map((team) => team.id);
    const rows = buildRoundRobinRows(teamIds);
    const gameCount = clampGamesPerMatch(gamesPerCourt[court.id] ?? 2);
    if (!rows.length) {
      showWidgetMessage("assign-courts", `No round robin schedule could be generated for ${court.name}.`, true);
      return;
    }

    const scoreHeaders = Array.from({ length: gameCount }, (_, index) => index + 1)
      .map((gameNumber) => `
        <th colspan="2">Game ${gameNumber} Score</th>
      `)
      .join("");

    const scoreSubHeaders = Array.from({ length: gameCount }, () => `
      <th>Team 1</th>
      <th>Team 2</th>
    `).join("");

    const bodyRows = rows.map((row) => {
      const byeName = row.byeTeamId ? (teamNameById.get(row.byeTeamId) ?? row.byeTeamId) : "-";
      const teamAName = teamNameById.get(row.teamAId) ?? row.teamAId;
      const teamBName = teamNameById.get(row.teamBId) ?? row.teamBId;
      const scoreCells = Array.from({ length: gameCount }, () => "<td></td><td></td>").join("");

      return `
        <tr>
          ${row.rowIndexWithinRound === 0 ? `<td rowspan="${row.matchesInRound}">${escapeHtml(byeName)}</td>` : ""}
          <td>${escapeHtml(teamAName)}</td>
          <td class="vs-cell">vs</td>
          <td>${escapeHtml(teamBName)}</td>
          ${scoreCells}
        </tr>
      `;
    }).join("");

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(court.name)} Round Robin</title>
    <style>
      @page { size: letter landscape; margin: 0.4in; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Arial", "Helvetica", sans-serif;
        color: #000;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 22px;
      }
      .meta {
        margin: 0 0 8px;
        font-size: 12px;
      }
      .note {
        text-align: center;
        font-size: 14px;
        margin: 8px 0;
        font-weight: 700;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      th,
      td {
        border: 1px solid #000;
        text-align: center;
        padding: 6px 4px;
        font-size: 13px;
        vertical-align: middle;
      }
      thead th {
        background: #f2f2f2;
      }
      td:first-child,
      th:first-child {
        width: 13%;
      }
      .court-col {
        width: 13%;
      }
      .vs-cell {
        width: 4%;
        font-weight: 700;
      }
      .print-actions {
        margin-top: 8px;
        display: flex;
        justify-content: flex-end;
      }
      .print-actions button {
        border: 1px solid #333;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        background: #fff;
      }
      @media print {
        .print-actions {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(court.name)} Court</h1>
    <p class="note">* Please record any use of substitutes, thanks!</p>
    <table>
      <thead>
        <tr>
          <th rowspan="2">Bye</th>
          <th colspan="3">${escapeHtml(court.name)}</th>
          ${scoreHeaders}
        </tr>
        <tr>
          <th class="court-col">Team 1</th>
          <th class="vs-cell">vs</th>
          <th class="court-col">Team 2</th>
          ${scoreSubHeaders}
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
    <div class="print-actions">
      <button type="button" onclick="window.print()">Print</button>
    </div>
  </body>
</html>`;

    const htmlBlob = new Blob([html], { type: "text/html" });
    const htmlUrl = URL.createObjectURL(htmlBlob);
    const printWindow = window.open(htmlUrl, "_blank");
    if (!printWindow) {
      URL.revokeObjectURL(htmlUrl);
      showWidgetMessage("assign-courts", "Pop-up blocked. Allow pop-ups to open the printable schedule.", true);
      return;
    }

    window.setTimeout(() => {
      URL.revokeObjectURL(htmlUrl);
    }, 60_000);
    showWidgetMessage("assign-courts", `Generated a printable schedule for ${court.name}.`);
  };

  const extractObjectId = (entry: AuthMeLegacyEntry | AuthMeCurrentEntry | undefined): string => {
    if (!entry) return "";

    const currentPrincipal = (entry as AuthMeCurrentEntry).clientPrincipal;
    if (currentPrincipal?.userId) return currentPrincipal.userId;

    const currentClaims = currentPrincipal?.claims ?? [];
    const currentOidClaim = currentClaims.find(
      (claim) =>
        claim.typ === "oid" ||
        claim.type === "oid" ||
        claim.typ === "http://schemas.microsoft.com/identity/claims/objectidentifier"
        || claim.type === "http://schemas.microsoft.com/identity/claims/objectidentifier"
    );
    const currentOidValue = currentOidClaim?.val ?? currentOidClaim?.value;
    if (currentOidValue) return currentOidValue;

    const legacyEntry = entry as AuthMeLegacyEntry;
    if (legacyEntry.user_id) return legacyEntry.user_id;

    const claims = legacyEntry.user_claims ?? [];
    const oidClaim = claims.find(
      (claim) =>
        claim.typ === "oid" ||
        claim.type === "oid" ||
        claim.typ === "http://schemas.microsoft.com/identity/claims/objectidentifier"
        || claim.type === "http://schemas.microsoft.com/identity/claims/objectidentifier"
    );

    return oidClaim?.val ?? oidClaim?.value ?? "";
  };

  const loadSignedInObjectId = useCallback(async (): Promise<string> => {
    try {
      const res = await authFetch("/.auth/me");
      if (!res.ok) {
        setEntraObjectId("");
        return "";
      }

      const data = (await res.json()) as Array<AuthMeLegacyEntry | AuthMeCurrentEntry>;
      const objectId = extractObjectId(data?.[0]);
      setEntraObjectId(objectId);
      return objectId;
    } catch {
      setEntraObjectId("");
      return "";
    }
  }, []);

  const loadAuthDebug = useCallback(async (): Promise<DebugAuthResponse> => {
    try {
      const res = await authFetch("/api/debug/auth");
      if (!res.ok) {
        setAuthDebug("");
        return {};
      }

      const payload = (await res.json()) as DebugAuthResponse;
      setAuthDebug(JSON.stringify(payload, null, 2));
      return payload;
    } catch {
      setAuthDebug("");
      return {};
    }
  }, []);

  const loadAdminData = useCallback(async (): Promise<void> => {
    let base = adminApiBase;
    let [lRes, cRes, tRes, pRes, mRes] = await Promise.all([
      authFetch(`${base}/leagues`),
      authFetch(`${base}/courts`),
      authFetch(`${base}/teams`),
      authFetch(`${base}/players`),
      authFetch(`${base}/matches`)
    ]);

    // If all collection endpoints are missing, try the alternate namespace.
    if ([lRes, cRes, tRes, pRes, mRes].every((res) => res.status === 404)) {
      base = base === "/api/ops" ? "/api/admin" : "/api/ops";
      [lRes, cRes, tRes, pRes, mRes] = await Promise.all([
        authFetch(`${base}/leagues`),
        authFetch(`${base}/courts`),
        authFetch(`${base}/teams`),
        authFetch(`${base}/players`),
        authFetch(`${base}/matches`)
      ]);
      setAdminApiBase(base);
    }

    if ([lRes, cRes, tRes, pRes, mRes].some((res) => res.status === 401 || res.status === 403)) {
      const statusSummary = `leagues=${lRes.status}, courts=${cRes.status}, teams=${tRes.status}, players=${pRes.status}, matches=${mRes.status}`;
      showWidgetMessage("global", `Signed in as admin, but one or more admin data endpoints were denied (${statusSummary}) via ${base}.`, true);
      return;
    }

    if (!lRes.ok || !cRes.ok || !tRes.ok || !pRes.ok || !mRes.ok) {
      const statusSummary = `leagues=${lRes.status}, courts=${cRes.status}, teams=${tRes.status}, players=${pRes.status}, matches=${mRes.status}`;
      showWidgetMessage("global", `Signed in as admin, but failed to load admin data (${statusSummary}) via ${base}.`, true);
      return;
    }

    const loadedLeagues: League[] = await lRes.json();
    const loadedCourts: Court[] = await cRes.json();
    const loadedTeams: Team[] = await tRes.json();
    const loadedPlayers: Player[] = await pRes.json();
    const loadedMatches: ManagedMatch[] = await mRes.json();

    setLeagues(loadedLeagues);
    setCourts(loadedCourts);
    setTeams(loadedTeams);
    setPlayers(loadedPlayers);
    setMatches(loadedMatches);

    try {
      const diagRes = await authFetch(`${base}/diagnostics`);
      if (diagRes.ok) {
        const diag = await diagRes.json() as ApiDiagnostics;
        setApiDiagnostics(diag);
      } else {
        setApiDiagnostics(null);
      }
    } catch {
      setApiDiagnostics(null);
    }

    const activeLoadedLeagues = loadedLeagues.filter((league) => league.isActive);
    const activeLoadedCourts = loadedCourts.filter((court) => court.isActive);

    if (!editingTeamIdRef.current) {
      const activeLoadedLeagueIds = activeLoadedLeagues.map((l) => l.id);
      setTeamForm((prev) => ({ ...prev, leagueIds: activeLoadedLeagueIds }));
    }

    setMatchForm((prev) => ({
      ...prev,
      leagueId: prev.leagueId || activeLoadedLeagues[0]?.id || "",
      courtId: prev.courtId || activeLoadedCourts[0]?.id || ""
    }));

    try {
      const datesRes = await authFetch("/api/exports/dupr/dates");
      if (datesRes.ok) {
        const dates: string[] = await datesRes.json();
        setMatchDates(dates);
        setCsvDate((prev) => prev || dates[0] || "");
      }
    } catch {
      // Non-critical — widget will fall back to empty list
    }
  }, [adminApiBase]);

  const checkAuthorization = useCallback(async () => {
    setAuthLoading(true);
    try {
      const debug = await loadAuthDebug();

      if (!debug.isAuthenticated) {
        setIsAuthorized(false);
        setAuthMessage("Please sign in with Microsoft Entra ID to access admin tools.");
        await loadSignedInObjectId();
      } else if (debug.isAdmin) {
        setIsAuthorized(true);
        setAuthMessage("");
        if (debug.objectId) {
          setEntraObjectId(debug.objectId);
        } else if (debug.candidateIds?.length) {
          setEntraObjectId(debug.candidateIds[0]);
        } else {
          await loadSignedInObjectId();
        }
        await loadAdminData();
      } else {
        setIsAuthorized(false);
        setAuthMessage("Your account is signed in, but not approved for admin access.");
        if (debug.objectId) {
          setEntraObjectId(debug.objectId);
        } else if (debug.candidateIds?.length) {
          setEntraObjectId(debug.candidateIds[0]);
        } else {
          await loadSignedInObjectId();
        }
      }
    } catch (error) {
      setIsAuthorized(false);
      setAuthMessage("Could not validate admin session. Try refreshing.");
      showWidgetMessage("global", error instanceof Error ? error.message : "Failed to validate admin session.", true);
    } finally {
      setAuthLoading(false);
    }
  }, [loadAdminData, loadAuthDebug, loadSignedInObjectId, showWidgetMessage]);

  useEffect(() => {
    checkAuthorization();
  }, [checkAuthorization]);

  const copyObjectId = async () => {
    if (!entraObjectId) return;

    try {
      await navigator.clipboard.writeText(entraObjectId);
      setCopyMessage("Object ID copied.");
    } catch {
      setCopyMessage("Unable to copy automatically. Please copy manually.");
    }
  };

  const onSavePlayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const res = await authFetch(editingPlayerId ? `${adminApiBase}/players/${editingPlayerId}` : `${adminApiBase}/players`, {
        method: editingPlayerId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(playerForm)
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("players", editingPlayerId ? "Player updated." : "Player added.");
      setEditingPlayerId(null);
      setPlayerForm({ ...emptyPlayerForm });
      await loadAdminData();
    } catch {
      showWidgetMessage("players", "Error saving player.", true);
    }
  };

  const onSaveTeam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const res = await authFetch(editingTeamId ? `${adminApiBase}/teams/${editingTeamId}` : `${adminApiBase}/teams`, {
        method: editingTeamId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(teamForm)
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("teams", editingTeamId ? "Team updated." : "Team added.");
      setEditingTeamId(null);
      setTeamForm({ ...emptyTeamForm });
      await loadAdminData();
    } catch {
      showWidgetMessage("teams", "Error saving team.", true);
    }
  };

  const onSaveLeague = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!leagueForm.endDate) {
      showWidgetMessage("leagues", "League end date is required.", true);
      return;
    }

    if (leagueForm.endDate < leagueForm.startDate) {
      showWidgetMessage("leagues", "League end date cannot be before start date.", true);
      return;
    }

    try {
      const res = await authFetch(editingLeagueId ? `${adminApiBase}/leagues/${editingLeagueId}` : `${adminApiBase}/leagues`, {
        method: editingLeagueId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leagueForm)
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("leagues", editingLeagueId ? "League updated." : "League added.");
      setEditingLeagueId(null);
      setLeagueForm({ ...emptyLeagueForm });
      await loadAdminData();
    } catch {
      showWidgetMessage("leagues", "Error saving league.", true);
    }
  };

  const onSaveCourt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const res = await authFetch(editingCourtId ? `${adminApiBase}/courts/${editingCourtId}` : `${adminApiBase}/courts`, {
        method: editingCourtId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(courtForm)
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("courts", editingCourtId ? "Court updated." : "Court added.");
      setEditingCourtId(null);
      setCourtForm({ ...emptyCourtForm });
      await loadAdminData();
    } catch {
      showWidgetMessage("courts", "Error saving court.", true);
    }
  };

  const onTogglePlayerActive = async (player: Player) => {
    try {
      const res = await authFetch(`${adminApiBase}/players/${player.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: player.firstName,
          lastName: player.lastName,
          duprId: player.duprId,
          defaultTeamId: player.defaultTeamId,
          isActive: !player.isActive
        })
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("players", player.isActive ? "Player deactivated." : "Player activated.");
      await loadAdminData();
    } catch {
      showWidgetMessage("players", "Error updating player status.", true);
    }
  };

  const onToggleTeamActive = async (team: Team) => {
    const endpoint = `${adminApiBase}/teams/${team.id}`;
    const payload = {
      name: team.name,
      isActive: !team.isActive
    };

    setLastTeamToggleDebug({
      timestamp: new Date().toISOString(),
      endpoint,
      teamId: team.id,
      previousIsActive: team.isActive,
      payload
    });

    try {
      const res = await authFetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const raw = await res.text().catch(() => "");
      let parsed: unknown = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = null;
        }
      }

      setLastTeamToggleDebug((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          response: {
            status: res.status,
            ok: res.ok,
            rawBody: raw,
            parsedBody: parsed
          }
        };
      });

      if (!res.ok) {
        const parsedObject = typeof parsed === "object" && parsed !== null
          ? (parsed as { message?: string; error?: string; traceId?: string })
          : null;
        const normalizedRaw = raw.trim();
        const fallbackText = normalizedRaw && !normalizedRaw.startsWith("<") ? normalizedRaw : "";
        const statusText = [res.status, res.statusText].filter(Boolean).join(" ");
        const fallbackMessage = fallbackText || `Error updating team status (HTTP ${statusText || res.status}).`;
        const trace = parsedObject?.traceId ? ` (trace: ${parsedObject.traceId})` : "";
        showWidgetMessage("teams", (parsedObject?.error || parsedObject?.message || fallbackMessage) + trace, true);
        return;
      }

      showWidgetMessage("teams", team.isActive ? "Team deactivated." : "Team activated.");
      await loadAdminData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastTeamToggleDebug((prev) => {
        if (!prev) return prev;
        return { ...prev, error: message };
      });
      showWidgetMessage("teams", `Error updating team status: ${message}`, true);
    }
  };

  const onToggleLeagueActive = async (league: League) => {
    try {
      const res = await authFetch(`${adminApiBase}/leagues/${league.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: league.name,
          startDate: league.startDate,
          endDate: league.endDate,
          isActive: !league.isActive
        })
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("leagues", league.isActive ? "League deactivated." : "League activated.");
      await loadAdminData();
    } catch {
      showWidgetMessage("leagues", "Error updating league status.", true);
    }
  };

  const onToggleCourtActive = async (court: Court) => {
    try {
      const res = await authFetch(`${adminApiBase}/courts/${court.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: court.name,
          isActive: !court.isActive
        })
      });
      if (!res.ok) throw new Error("failed");
      showWidgetMessage("courts", court.isActive ? "Court deactivated." : "Court activated.");
      await loadAdminData();
    } catch {
      showWidgetMessage("courts", "Error updating court status.", true);
    }
  };

  const onEditMatch = (match: ManagedMatch) => {
    setEditingMatchId(match.id);
    setMatchError("");
    setMatchSuccess("");
    setMatchForm({
      leagueId: match.leagueId,
      courtId: match.courtId,
      scoringType: match.scoringType,
      gameType: match.gameType,
      date: match.date,
      teamAId: match.teamAId,
      teamBId: match.teamBId,
      teamAPlayer1: match.teamAPlayers[0],
      teamAPlayer2: match.teamAPlayers[1],
      teamBPlayer1: match.teamBPlayers[0],
      teamBPlayer2: match.teamBPlayers[1],
      scoreA: String(match.scoreA),
      scoreB: String(match.scoreB)
    });
    setTimeout(() => {
      matchFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const onCancelMatchEdit = () => {
    setEditingMatchId(null);
    setMatchForm((prev) => ({ ...prev, scoreA: "", scoreB: "" }));
  };

  const onDeleteMatch = async (matchId: string) => {
    try {
      const res = await authFetch(`${adminApiBase}/matches/${matchId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("failed");
      if (editingMatchId === matchId) {
        setEditingMatchId(null);
      }
      showWidgetMessage("matches", "Match deleted.");
      await loadAdminData();
    } catch {
      showWidgetMessage("matches", "Error deleting match.", true);
    }
  };

  const submitMatch = async () => {
    if (isSavingMatch) {
      return;
    }

    setIsSavingMatch(true);
    setMatchError("");
    setMatchSuccess("");

    const failMatchValidation = (message: string) => {
      setMatchError(message);
      setIsSavingMatch(false);
      setTimeout(() => {
        matchFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    };

    if (!matchForm.courtId) {
      failMatchValidation("Please select a court.");
      return;
    }

    if (matchForm.gameType === "Doubles" && (!matchForm.teamAId || !matchForm.teamBId)) {
      failMatchValidation("Please select both teams.");
      return;
    }

    const pickedPlayersEarly = [matchForm.teamAPlayer1, matchForm.teamAPlayer2, matchForm.teamBPlayer1, matchForm.teamBPlayer2];
    if (pickedPlayersEarly.some((id) => !id)) {
      failMatchValidation("Please select all four players.");
      return;
    }

    if (matchForm.gameType === "Doubles" && matchForm.teamAId === matchForm.teamBId) {
      failMatchValidation("Team A and Team B must be different.");
      return;
    }

    const pickedPlayers = [matchForm.teamAPlayer1, matchForm.teamAPlayer2, matchForm.teamBPlayer1, matchForm.teamBPlayer2];
    if (new Set(pickedPlayers).size !== 4) {
      failMatchValidation("All selected players must be unique within a match.");
      return;
    }

    const scoreA = Number(matchForm.scoreA);
    const scoreB = Number(matchForm.scoreB);
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 || scoreA === scoreB) {
      failMatchValidation("Scores must be whole numbers and cannot be tied.");
      return;
    }

    try {
      const wasEditing = Boolean(editingMatchId);
      const endpoint = editingMatchId ? `${adminApiBase}/matches/${editingMatchId}` : `${adminApiBase}/matches`;
      const payload = {
        leagueId: matchForm.leagueId,
        courtId: matchForm.courtId,
        scoringType: matchForm.scoringType,
        gameType: matchForm.gameType,
        date: matchForm.date,
        teamAId: matchForm.gameType === "Doubles" ? matchForm.teamAId : null,
        teamBId: matchForm.gameType === "Doubles" ? matchForm.teamBId : null,
        teamAPlayers: [matchForm.teamAPlayer1, matchForm.teamAPlayer2],
        teamBPlayers: [matchForm.teamBPlayer1, matchForm.teamBPlayer2],
        scoreA,
        scoreB
      };

      setLastMatchSubmitDebug({
        timestamp: new Date().toISOString(),
        phase: "requesting",
        mode: wasEditing ? "update" : "create",
        endpoint,
        editingMatchId,
        payload
      });

      const res = await authFetch(endpoint, {
        method: editingMatchId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const raw = await res.text().catch(() => "");
      let parsed: unknown = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = null;
        }
      }

      setLastMatchSubmitDebug((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          phase: "response",
          response: {
            status: res.status,
            ok: res.ok,
            rawBody: raw,
            parsedBody: parsed
          }
        };
      });

      if (!res.ok) {
        const parsedObject = typeof parsed === "object" && parsed !== null
          ? (parsed as { message?: string; error?: string; traceId?: string })
          : null;

        const normalizedRaw = raw.trim();
        const fallbackText = normalizedRaw && !normalizedRaw.startsWith("<") ? normalizedRaw : "";
        const statusText = [res.status, res.statusText].filter(Boolean).join(" ");
        const fallbackMessage = fallbackText || `Failed to record match (HTTP ${statusText || res.status}).`;
        const trace = parsedObject?.traceId ? ` (trace: ${parsedObject.traceId})` : "";
        failMatchValidation((parsedObject?.error || parsedObject?.message || fallbackMessage) + trace);
        return;
      }

      setEditingMatchId(null);
      const successMessage = wasEditing ? "✓ Match updated successfully." : "✓ Match result recorded.";
      setMatchSuccess(successMessage);
      setMatchForm({
        leagueId: matchForm.leagueId,
        courtId: matchForm.courtId,
        scoringType: matchForm.scoringType,
        gameType: matchForm.gameType,
        date: matchForm.date,
        teamAId: "",
        teamBId: "",
        teamAPlayer1: "",
        teamAPlayer2: "",
        teamBPlayer1: "",
        teamBPlayer2: "",
        scoreA: "",
        scoreB: ""
      });
      setTimeout(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, 50);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const networkMessage = `Network error: ${msg}`;
      setLastMatchSubmitDebug((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          phase: "network-error",
          error: networkMessage
        };
      });
      setMatchError(networkMessage);
      setTimeout(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, 50);
      setIsSavingMatch(false);
      return;
    }
    await loadAdminData().catch(() => {
      setLastMatchSubmitDebug((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          phase: "refresh-failed",
          error: "Saved, but list refresh failed."
        };
      });
      setMatchError("Saved, but list refresh failed.");
    });
    setLastMatchSubmitDebug((prev) => {
      if (!prev || prev.phase === "refresh-failed") return prev;
      return {
        ...prev,
        phase: "refresh-success"
      };
    });
    setIsSavingMatch(false);
  };

  const onRecordMatch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitMatch();
  };

  const exportMatchesForDay = async () => {
    try {
      const res = await authFetch(`/api/exports/dupr?date=${csvDate}`);
      if (!res.ok) {
        showWidgetMessage("export", "Export failed. No matches for that date, or server error.", true);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `hwpl-dupr-export-${csvDate}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      showWidgetMessage("export", `Export triggered for ${csvDate}.`);
    } catch {
      showWidgetMessage("export", "Export failed.", true);
    }
  };

  if (authLoading) {
    return (
      <main className="app-shell">
        <section className="panel">
          <h3>Checking Admin Access</h3>
          <p>Validating your Microsoft Entra sign-in...</p>
        </section>
      </main>
    );
  }

  if (!isAuthorized) {
    return (
      <main className="app-shell">
        <section className="panel">
          <h3>Admin Access Required</h3>
          <p>{authMessage}</p>
          <div className="admin-identity-box">
            <h4>Who Am I</h4>
            <p>Use this Entra Object ID in ADMIN_ENTRA_OBJECT_IDS to grant admin access.</p>
            <div className="admin-identity-row">
              <code>{entraObjectId || "Sign in to view your Entra Object ID"}</code>
              <button type="button" onClick={copyObjectId} disabled={!entraObjectId}>
                Copy ID
              </button>
            </div>
            {copyMessage ? <p className="status-msg">{copyMessage}</p> : null}
            {authDebug ? <pre className="auth-debug">{authDebug}</pre> : null}
          </div>
          <div className="admin-auth-links">
            <a className="admin-link" href="/.auth/login/aad?post_login_redirect_uri=/admin">Sign in with Entra ID</a>
            <a className="admin-link" href="/">Back to public stats</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-brand-row">
          <img className="club-logo" src="/brand/HW PickleBall Logo.png" alt="Hiram Walker Pickleball Club logo" />
          <div>
            <p className="eyebrow">HWPL Administration</p>
            <h1>{adminView === "league-data" ? "League Data" : "Assign Courts"}</h1>
          </div>
        </div>
        <p>
          {adminView === "league-data"
            ? "Manage players, teams, leagues, match entries, and exports."
            : "Assign active teams to active courts and generate printable round robin score sheets."}
        </p>
        <div className="admin-auth-links admin-auth-links-hero">
          <a className="admin-link" href="/">Public stats</a>
          <a className="admin-link" href="/.auth/logout?post_logout_redirect_uri=/">Sign out</a>
        </div>
      </section>

      {renderWidgetMessage("global")}

      <section className="panel admin-tabs" aria-label="Admin pages">
        <button
          type="button"
          className={adminView === "league-data" ? "active" : ""}
          onClick={() => setAdminView("league-data")}
        >
          League Data
        </button>
        <button
          type="button"
          className={adminView === "assign-courts" ? "active" : ""}
          onClick={() => setAdminView("assign-courts")}
        >
          Assign Courts
        </button>
      </section>

      {adminView === "league-data" ? (
      <section className="admin-grid">
        <article className="panel module-record-match" ref={matchFormRef}>
          <div className="panel-header">
            <h3>{editingMatchId ? "Edit Match Result" : "Record Match Result"}</h3>
            <p>{editingMatchId ? "Update the fields below and press Update Match to save." : "Admins can add individual match outcomes."}</p>
          </div>
          {renderWidgetMessage("match")}
          <form className="match-form" onSubmit={onRecordMatch} noValidate>
            {matchError ? <p className="form-error" style={{fontSize: "1rem", padding: "0.75rem", marginBottom: "0.5rem"}}>{matchError}</p> : null}
            {matchSuccess ? <p className="status-msg" style={{fontSize: "1rem", padding: "0.75rem", marginBottom: "0.5rem", background: "#d4edda", border: "1px solid #28a745", borderRadius: "4px"}}>{matchSuccess}</p> : null}
            {lastMatchSubmitDebug ? (
              <details style={{ marginBottom: "0.75rem" }}>
                <summary>Match Submit Debug (last attempt)</summary>
                {apiDiagnostics ? (
                  <p className="status-msg" style={{ marginTop: "0.5rem" }}>
                    API diagnostics: {apiDiagnostics.version} ({apiDiagnostics.timestamp})
                  </p>
                ) : (
                  <p className="status-msg" style={{ marginTop: "0.5rem" }}>
                    API diagnostics unavailable.
                  </p>
                )}
                <pre className="auth-debug" style={{ marginTop: "0.5rem" }}>{JSON.stringify(lastMatchSubmitDebug, null, 2)}</pre>
              </details>
            ) : null}
            <label>
              League
              <select value={matchForm.leagueId} onChange={(e) => setMatchForm((prev) => ({ ...prev, leagueId: e.target.value }))}>
                {matchFormLeagues.map((league) => (
                  <option key={league.id} value={league.id}>
                    {league.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Court
              <select value={matchForm.courtId} onChange={(e) => setMatchForm((prev) => ({ ...prev, courtId: e.target.value }))}>
                {matchFormCourts.map((court) => (
                  <option key={court.id} value={court.id}>
                    {court.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="teams-grid">
              <label>
                Scoring Type
                <select value={matchForm.scoringType} onChange={(e) => setMatchForm((prev) => ({ ...prev, scoringType: e.target.value as "Sideout" | "Rally" }))}>
                  <option value="Sideout">Sideout</option>
                  <option value="Rally">Rally</option>
                </select>
              </label>
              <label>
                Game Type
                <select
                  value={matchForm.gameType}
                  onChange={(e) => {
                    const nextGameType = e.target.value as "Doubles" | "Ladder";
                    setMatchForm((prev) => ({
                      ...prev,
                      gameType: nextGameType,
                      teamAId: nextGameType === "Ladder" ? "" : prev.teamAId,
                      teamBId: nextGameType === "Ladder" ? "" : prev.teamBId,
                      ...(nextGameType === "Ladder"
                        ? {}
                        : (() => {
                            const [teamAPlayer1, teamAPlayer2] = getPreferredPlayerPairForTeam(prev.teamAId, []);
                            const [teamBPlayer1, teamBPlayer2] = getPreferredPlayerPairForTeam(prev.teamBId, [teamAPlayer1, teamAPlayer2]);
                            return { teamAPlayer1, teamAPlayer2, teamBPlayer1, teamBPlayer2 };
                          })())
                    }));
                  }}
                >
                  <option value="Doubles">Doubles</option>
                  <option value="Ladder">Ladder</option>
                </select>
              </label>
            </div>
            <label>
              Date
              <input type="date" value={matchForm.date} onChange={(e) => setMatchForm((prev) => ({ ...prev, date: e.target.value }))} required />
            </label>
            {matchForm.gameType === "Doubles" ? (
              <div className="teams-grid">
                <div className="match-team-column">
                  <label>
                    Team A
                    <select
                      value={matchForm.teamAId}
                      onChange={(e) => {
                        const nextTeamAId = e.target.value;
                        setMatchForm((prev) => {
                          if (editingMatchId) {
                            return { ...prev, teamAId: nextTeamAId };
                          }
                          const [teamAPlayer1, teamAPlayer2] = getPreferredPlayerPairForTeam(nextTeamAId, [prev.teamBPlayer1, prev.teamBPlayer2]);
                          return { ...prev, teamAId: nextTeamAId, teamAPlayer1, teamAPlayer2 };
                        });
                      }}
                      required
                    >
                      <option value="">Select a team…</option>
                      {matchFormTeams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Team A - Player 1
                    <select value={matchForm.teamAPlayer1} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamAPlayer1: e.target.value }))}>
                      <option value="">Select a player…</option>
                      {getAvailablePlayersForSlot("teamAPlayer1").map((player) => (
                        <option key={player.id} value={player.id}>
                          {player.firstName} {player.lastName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Team A - Player 2
                    <select value={matchForm.teamAPlayer2} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamAPlayer2: e.target.value }))}>
                      <option value="">Select a player…</option>
                      {getAvailablePlayersForSlot("teamAPlayer2").map((player) => (
                        <option key={player.id} value={player.id}>
                          {player.firstName} {player.lastName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="match-team-column">
                  <label>
                    Team B
                    <select
                      value={matchForm.teamBId}
                      onChange={(e) => {
                        const nextTeamBId = e.target.value;
                        setMatchForm((prev) => {
                          if (editingMatchId) {
                            return { ...prev, teamBId: nextTeamBId };
                          }
                          const [teamBPlayer1, teamBPlayer2] = getPreferredPlayerPairForTeam(nextTeamBId, [prev.teamAPlayer1, prev.teamAPlayer2]);
                          return { ...prev, teamBId: nextTeamBId, teamBPlayer1, teamBPlayer2 };
                        });
                      }}
                      required
                    >
                      <option value="">Select a team…</option>
                      {matchFormTeams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Team B - Player 1
                    <select value={matchForm.teamBPlayer1} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamBPlayer1: e.target.value }))}>
                      <option value="">Select a player…</option>
                      {getAvailablePlayersForSlot("teamBPlayer1").map((player) => (
                        <option key={player.id} value={player.id}>
                          {player.firstName} {player.lastName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Team B - Player 2
                    <select value={matchForm.teamBPlayer2} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamBPlayer2: e.target.value }))}>
                      <option value="">Select a player…</option>
                      {getAvailablePlayersForSlot("teamBPlayer2").map((player) => (
                        <option key={player.id} value={player.id}>
                          {player.firstName} {player.lastName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : (
              <>
                <p className="status-msg">Ladder matches do not use teams. Select four players and the court.</p>
                <div className="teams-grid">
                  <div className="match-team-column">
                    <label>
                      Side A - Player 1
                      <select value={matchForm.teamAPlayer1} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamAPlayer1: e.target.value }))}>
                        <option value="">Select a player…</option>
                        {getAvailablePlayersForSlot("teamAPlayer1").map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.firstName} {player.lastName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Side A - Player 2
                      <select value={matchForm.teamAPlayer2} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamAPlayer2: e.target.value }))}>
                        <option value="">Select a player…</option>
                        {getAvailablePlayersForSlot("teamAPlayer2").map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.firstName} {player.lastName}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="match-team-column">
                    <label>
                      Side B - Player 1
                      <select value={matchForm.teamBPlayer1} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamBPlayer1: e.target.value }))}>
                        <option value="">Select a player…</option>
                        {getAvailablePlayersForSlot("teamBPlayer1").map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.firstName} {player.lastName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Side B - Player 2
                      <select value={matchForm.teamBPlayer2} onChange={(e) => setMatchForm((prev) => ({ ...prev, teamBPlayer2: e.target.value }))}>
                        <option value="">Select a player…</option>
                        {getAvailablePlayersForSlot("teamBPlayer2").map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.firstName} {player.lastName}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </>
            )}
            <div className="score-row">
              <label>
                Team A Score
                <input type="number" min={0} step={1} value={matchForm.scoreA} onChange={(e) => setMatchForm((prev) => ({ ...prev, scoreA: e.target.value }))} required />
              </label>
              <label>
                Team B Score
                <input type="number" min={0} step={1} value={matchForm.scoreB} onChange={(e) => setMatchForm((prev) => ({ ...prev, scoreB: e.target.value }))} required />
              </label>
            </div>
            <button type="submit" disabled={isSavingMatch}>
              {isSavingMatch ? (editingMatchId ? "Updating..." : "Saving...") : (editingMatchId ? "Update Match" : "Save Match")}
            </button>
            {editingMatchId ? (
              <button type="button" onClick={onCancelMatchEdit}>
                Cancel Edit
              </button>
            ) : null}
          </form>
        </article>

        <article className="panel module-export-dupr">
          <div className="panel-header">
            <h3>CSV Export for DUPR</h3>
            <p>Exports all matches for one day.</p>
          </div>
          {renderWidgetMessage("export")}
          <div className="match-form">
            <label>
              Export Date
              {matchDates.length > 0 ? (
                <select value={csvDate} onChange={(e) => setCsvDate(e.target.value)}>
                  <option value="">Select a date…</option>
                  {matchDates.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              ) : (
                <input type="date" value={csvDate} onChange={(e) => setCsvDate(e.target.value)} />
              )}
            </label>
            <button type="button" onClick={exportMatchesForDay} disabled={!csvDate}>
              Export CSV
            </button>
          </div>
        </article>

        <article className="panel module-manage-matches">
          <div className="panel-header">
            <h3>Manage Matches</h3>
            <p>Edit or delete existing matches.</p>
          </div>
          {renderWidgetMessage("matches")}
          <div className="match-form" style={{ marginBottom: "0.75rem" }}>
            <div className="teams-grid">
              <label>
                Filter by Team
                <select value={matchTeamFilterId} onChange={(e) => setMatchTeamFilterId(e.target.value)}>
                  <option value="">All teams</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Filter by Player
                <select value={matchPlayerFilterId} onChange={(e) => setMatchPlayerFilterId(e.target.value)}>
                  <option value="">All players</option>
                  {players.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.firstName} {player.lastName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Filter by Date
                <select value={matchDateFilter} onChange={(e) => setMatchDateFilter(e.target.value)}>
                  <option value="">All dates</option>
                  {matchDateOptions.map((date) => (
                    <option key={date} value={date}>
                      {date}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {editingMatchId ? (
            <p className="status-msg">Currently editing a match — scroll up to the Record Match form to save or cancel.</p>
          ) : null}
          <ul className="entity-list">
            {filteredMatches.map((match) => (
              <li key={match.id}>
                <span>
                  {match.date} - {match.teamAName} ({match.scoreA}) vs {match.teamBName} ({match.scoreB}) - {match.gameType}, {match.scoringType}, {match.courtName || "No court"}
                </span>
                <div>
                  <button type="button" onClick={() => onEditMatch(match)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => onDeleteMatch(match.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {filteredMatches.length === 0 ? (
              <li>
                <span>No matches found for the selected filters.</span>
              </li>
            ) : null}
          </ul>
        </article>

        <article className="panel module-manage-players">
          <div className="panel-header">
            <h3>Manage Players</h3>
            <p>Add, activate/deactivate, or modify player records.</p>
          </div>
          {renderWidgetMessage("players")}
          <form className="match-form" onSubmit={onSavePlayer}>
            <div className="teams-grid">
              <label>
                First Name
                <input value={playerForm.firstName} onChange={(e) => setPlayerForm((prev) => ({ ...prev, firstName: e.target.value }))} required />
              </label>
              <label>
                Last Name
                <input value={playerForm.lastName} onChange={(e) => setPlayerForm((prev) => ({ ...prev, lastName: e.target.value }))} required />
              </label>
              <label>
                DUPR ID
                <input value={playerForm.duprId} onChange={(e) => setPlayerForm((prev) => ({ ...prev, duprId: e.target.value }))} required />
              </label>
              <label>
                Default Team
                <select
                  value={playerForm.defaultTeamId}
                  onChange={(e) => setPlayerForm((prev) => ({ ...prev, defaultTeamId: e.target.value }))}
                >
                  <option value="">No default team</option>
                  {activeTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button type="submit">{editingPlayerId ? "Update Player" : "Add Player"}</button>
          </form>
          <ul className="entity-list">
            {players.map((player) => (
              <li key={player.id}>
                <span>{`${player.firstName} ${player.lastName}`} ({player.duprId})</span>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPlayerId(player.id);
                      setPlayerForm({
                        firstName: player.firstName,
                        lastName: player.lastName,
                        duprId: player.duprId,
                        defaultTeamId: player.defaultTeamId ?? "",
                        isActive: player.isActive
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={player.isActive ? "danger" : ""} onClick={() => onTogglePlayerActive(player)}>
                    {player.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel module-manage-teams">
          <div className="panel-header">
            <h3>Manage Teams</h3>
            <p>Add, activate/deactivate, or modify team records.</p>
          </div>
          {renderWidgetMessage("teams")}
          {lastTeamToggleDebug ? (
            <details style={{ marginBottom: "0.75rem" }}>
              <summary>Team Toggle Debug (last attempt)</summary>
              <pre className="auth-debug" style={{ marginTop: "0.5rem" }}>{JSON.stringify(lastTeamToggleDebug, null, 2)}</pre>
            </details>
          ) : null}
          <form className="match-form" onSubmit={onSaveTeam}>
            <label>
              Team Name
              <input value={teamForm.name} onChange={(e) => setTeamForm((prev) => ({ ...prev, name: e.target.value }))} required />
            </label>
            <fieldset style={{ border: "1px solid #ccc", borderRadius: 4, padding: "8px 12px" }}>
              <legend>Leagues</legend>
              {leagues.map((league) => (
                <label key={league.id} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: "normal", marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={teamForm.leagueIds.includes(league.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setTeamForm((prev) => ({ ...prev, leagueIds: [...prev.leagueIds, league.id] }));
                      } else {
                        setTeamForm((prev) => ({ ...prev, leagueIds: prev.leagueIds.filter((lid) => lid !== league.id) }));
                      }
                    }}
                  />
                  {league.name}
                </label>
              ))}
            </fieldset>
            <button type="submit">{editingTeamId ? "Update Team" : "Add Team"}</button>
          </form>
          <ul className="entity-list">
            {teams.map((team) => (
              <li key={team.id}>
                <span>
                  {team.name}
                  {team.leagueIds.length > 0 && (
                    <> - {team.leagueIds.map((lid) => leagueNameById.get(lid) ?? lid).join(", ")}</>
                  )}
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingTeamId(team.id);
                      setTeamForm({ name: team.name, leagueIds: team.leagueIds, isActive: team.isActive });
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={team.isActive ? "danger" : ""} onClick={() => onToggleTeamActive(team)}>
                    {team.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel module-manage-leagues">
          <div className="panel-header">
            <h3>Manage Leagues</h3>
            <p>Add, activate/deactivate, or modify leagues.</p>
          </div>
          {renderWidgetMessage("leagues")}
          <form className="match-form" onSubmit={onSaveLeague}>
            <label>
              League Name
              <input value={leagueForm.name} onChange={(e) => setLeagueForm((prev) => ({ ...prev, name: e.target.value }))} required />
            </label>
            <label>
              Start Date
              <input
                type="date"
                value={leagueForm.startDate}
                onChange={(e) => setLeagueForm((prev) => ({ ...prev, startDate: e.target.value }))}
                required
              />
            </label>
            <label>
              End Date
              <input
                type="date"
                value={leagueForm.endDate}
                onChange={(e) => setLeagueForm((prev) => ({ ...prev, endDate: e.target.value }))}
                required
              />
            </label>
            <label>
              Active
              <select
                value={leagueForm.isActive ? "yes" : "no"}
                onChange={(e) => setLeagueForm((prev) => ({ ...prev, isActive: e.target.value === "yes" }))}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <button type="submit">{editingLeagueId ? "Update League" : "Add League"}</button>
          </form>
          <ul className="entity-list">
            {leagues.map((league) => (
              <li key={league.id}>
                <span>{league.name} ({formatLeagueDates(league)})</span>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingLeagueId(league.id);
                      setLeagueForm({
                        name: league.name,
                        startDate: league.startDate,
                        endDate: league.endDate,
                        isActive: league.isActive
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={league.isActive ? "danger" : ""} onClick={() => onToggleLeagueActive(league)}>
                    {league.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel module-manage-courts">
          <div className="panel-header">
            <h3>Manage Courts</h3>
            <p>Add, activate/deactivate, or modify courts.</p>
          </div>
          {renderWidgetMessage("courts")}
          <form className="match-form" onSubmit={onSaveCourt}>
            <label>
              Court Name
              <input value={courtForm.name} onChange={(e) => setCourtForm((prev) => ({ ...prev, name: e.target.value }))} required />
            </label>
            <button type="submit">{editingCourtId ? "Update Court" : "Add Court"}</button>
          </form>
          <ul className="entity-list">
            {courts.map((court) => (
              <li key={court.id}>
                <span>{court.name}</span>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCourtId(court.id);
                      setCourtForm({ name: court.name, isActive: court.isActive });
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={court.isActive ? "danger" : ""} onClick={() => onToggleCourtActive(court)}>
                    {court.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </article>

      </section>
      ) : (
      <section className="assign-courts-layout">
        <article className="panel">
          <div className="panel-header">
            <h3>Team Court Assignments</h3>
            <p>Drag teams from the list onto a court, or drop on Unassigned to remove placement.</p>
          </div>
          {renderWidgetMessage("assign-courts")}
          <div className="assign-courts-toolbar">
            <p>
              Active teams: {activeTeams.length} | Active courts: {activeCourts.length} | Unassigned teams: {unassignedTeams.length}
            </p>
            <button type="button" onClick={onClearAllAssignments}>
              Clear All Assignments
            </button>
          </div>

          <div className="assign-dnd-layout">
            <section
              className="assign-court-card assign-drop-target"
              onDragOver={onAllowDrop}
              onDrop={onDropTeamToUnassigned}
            >
              <header>
                <h4>Unassigned Teams</h4>
                <p>{unassignedTeams.length} team(s)</p>
              </header>
              <div className="assign-team-pool">
                {unassignedTeams.length === 0 ? (
                  <p className="status-msg">Drop teams here to clear their court assignment.</p>
                ) : (
                  unassignedTeams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      className="team-chip"
                      draggable
                      onDragStart={(event) => onTeamDragStart(event, team.id)}
                      onDragEnd={onTeamDragEnd}
                    >
                      <span>{team.name}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <div className="assign-courts-column">
              {activeCourts.length === 0 ? (
                <p className="form-error">No active courts are available. Activate at least one court in League Data first.</p>
              ) : (
                orderedActiveCourts.map((court) => {
                  const assignedTeams = assignedTeamsByCourt[court.id] ?? [];
                  return (
                    <section
                      key={court.id}
                      className="assign-court-card assign-drop-target"
                      onDragOver={onAllowDrop}
                      onDrop={(event) => onDropTeamToCourt(event, court.id)}
                    >
                      <header>
                        <h4>{court.name}</h4>
                        <p>{assignedTeams.length} assigned team(s)</p>
                      </header>

                      <label>
                        Number of games per matchup
                        <input
                          type="number"
                          min={MIN_GAMES_PER_MATCH}
                          max={MAX_GAMES_PER_MATCH}
                          value={gamesPerCourt[court.id] ?? 2}
                          onChange={(event) => onChangeGamesPerCourt(court.id, event.target.value)}
                        />
                      </label>

                      <div className="assign-court-team-list">
                        {assignedTeams.length === 0 ? (
                          <p>Drop teams here.</p>
                        ) : (
                          assignedTeams.map((team) => (
                            <button
                              key={team.id}
                              type="button"
                              className="team-chip"
                              draggable
                              onDragStart={(event) => onTeamDragStart(event, team.id)}
                              onDragEnd={onTeamDragEnd}
                            >
                              <span>{team.name}</span>
                            </button>
                          ))
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => openRoundRobinPrintWindow(court)}
                        disabled={assignedTeams.length < 2}
                      >
                        Generate Matches
                      </button>
                    </section>
                  );
                })
              )}
            </div>
          </div>
        </article>
      </section>
      )}

    </main>
  );
}

export default AdminPage;

