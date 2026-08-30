export type TeamSide = "A" | "B";

export interface League {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  /** Optional announcement HTML shown under the league picker on the stats page. */
  messageHtml: string;
}

export interface Court {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Location {
  id: string;
  name: string;
  address: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface Team {
  id: string;
  name: string;
  leagueIds: string[];
  isActive: boolean;
}

export interface Player {
  id: string;
  firstName: string;
  lastName: string;
  duprId: string;
  defaultTeamId: string | null;
  isActive: boolean;
}

export interface StatsRow {
  id: string;
  name: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  differential: number;
  winRate: number;
}

export interface LeagueStatRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  // Optional: a static snapshot exported before league messages existed won't have it.
  messageHtml?: string;
  matches: number;
  avgPointsPerMatch: number;
}

export interface MatchParticipantDetail {
  playerId: string;
  playerName: string;
  teamSide: TeamSide;
  participantOrder: number;
  teamId: string | null;
}

export interface PublicMatch {
  id: string;
  date: string;
  leagueId: string;
  leagueName: string;
  leagueStartDate: string;
  leagueEndDate: string;
  courtId: string | null;
  courtName: string;
  // Optional: a static snapshot exported before locations existed won't have them.
  locationId?: string | null;
  locationName?: string;
  scoringType: "Sideout" | "Rally";
  gameType: "Doubles" | "Ladder";
  teamAId: string | null;
  teamBId: string | null;
  teamAName: string;
  teamBName: string;
  scoreA: number;
  scoreB: number;
  participants: MatchParticipantDetail[];
}

export interface SessionTeamStat {
  teamId: string;
  teamName: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  differential: number;
  winRate: number;
}

export interface SessionPlayerStat {
  playerId: string;
  playerName: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  differential: number;
  winRate: number;
}

export interface SessionCourtEntry {
  courtId: string;
  courtName: string;
  doubles: SessionTeamStat[];
  ladder: SessionPlayerStat[];
}
