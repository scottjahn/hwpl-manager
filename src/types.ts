export type TeamSide = "A" | "B";
export type Persona = "user" | "admin";

export interface League {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
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

export interface Match {
  id: string;
  leagueId: string;
  courtId: string;
  locationId: string;
  scoringType: "Sideout" | "Rally";
  gameType: "Doubles" | "Ladder";
  date: string;
  teamAId: string | null;
  teamBId: string | null;
  teamAPlayers: [string, string];
  teamBPlayers: [string, string];
  scoreA: number;
  scoreB: number;
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
  matches: number;
  avgPointsPerMatch: number;
}

export interface RecentMatch {
  id: string;
  date: string;
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
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
