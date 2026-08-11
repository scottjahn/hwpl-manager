// Local SQLite data layer for HWPL.
//
// The single source of truth, edited locally (weekly) through the admin server
// and read by the export script. It never runs in production — the deployed
// site is fully static (public/data/**). Replaces the old Azure SQL (`mssql`)
// backend in api/.

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const DB_PATH = process.env.HWPL_DB ?? join(ROOT, 'data', 'hwpl.db');
const SCHEMA_PATH = join(ROOT, 'database', 'schema.sqlite.sql');

let db;

/** The club's home venue — seeded the first time the locations table is empty. */
export const HOME_LOCATION = {
  name: 'WFCU Centre Sports Gym',
  address: '8787 McHugh St., Windsor, Ontario, Canada, N8S 0A1',
};

/** Open (and lazily initialise) the SQLite database. */
export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8')); // idempotent (CREATE ... IF NOT EXISTS)
  migrate(db);
  return db;
}

export const newId = () => crypto.randomUUID();
const bool = (v) => !!v;

/**
 * Schema changes that CREATE TABLE IF NOT EXISTS can't apply to a database that
 * already has rows. Idempotent — runs on every open.
 */
function migrate(d) {
  const matchColumns = d.prepare(`PRAGMA table_info(matches)`).all().map((c) => c.name);
  if (!matchColumns.includes('location_id')) {
    d.exec(`ALTER TABLE matches ADD COLUMN location_id TEXT REFERENCES locations(id)`);
  }

  if (d.prepare(`SELECT COUNT(*) AS n FROM locations`).get().n === 0) {
    d.prepare(
      `INSERT INTO locations (id, name, address, is_default, is_active) VALUES (?, ?, ?, 1, 1)`
    ).run(newId(), HOME_LOCATION.name, HOME_LOCATION.address);
  }

  // Matches recorded before locations existed (or before a default was set)
  // belong to the default venue.
  const defaultId = defaultLocationId(d);
  if (defaultId) {
    d.prepare(`UPDATE matches SET location_id = ? WHERE location_id IS NULL`).run(defaultId);
  }
}

/** Id of the location flagged as default, or null when none is. */
export function defaultLocationId(d = getDb()) {
  return d.prepare(`SELECT id FROM locations WHERE is_default = 1`).get()?.id ?? null;
}

/**
 * Load the entire database into plain JS objects (camelCase), with each match's
 * participants nested. The dataset is small (a club league), so every derived
 * stat is then computed in JS — see tools/stats.mjs. This keeps the read logic
 * in one place instead of porting the old T-SQL queries.
 */
export function loadRaw(d = getDb()) {
  const leagues = d.prepare(
    `SELECT id, name, start_date, end_date, is_active FROM leagues`
  ).all().map((r) => ({
    id: r.id, name: r.name, startDate: r.start_date,
    endDate: r.end_date, isActive: bool(r.is_active),
  }));

  const teams = d.prepare(
    `SELECT id, name, is_active FROM teams`
  ).all().map((r) => ({ id: r.id, name: r.name, isActive: bool(r.is_active) }));

  const courts = d.prepare(
    `SELECT id, name, is_active FROM courts`
  ).all().map((r) => ({ id: r.id, name: r.name, isActive: bool(r.is_active) }));

  const locations = d.prepare(
    `SELECT id, name, address, is_default, is_active FROM locations`
  ).all().map((r) => ({
    id: r.id, name: r.name, address: r.address,
    isDefault: bool(r.is_default), isActive: bool(r.is_active),
  }));

  const teamLeagues = d.prepare(
    `SELECT team_id, league_id FROM team_leagues`
  ).all().map((r) => ({ teamId: r.team_id, leagueId: r.league_id }));

  const players = d.prepare(
    `SELECT id, first_name, last_name, dupr_id, default_team_id, is_active FROM players`
  ).all().map((r) => ({
    id: r.id, firstName: r.first_name, lastName: r.last_name,
    duprId: r.dupr_id, defaultTeamId: r.default_team_id, isActive: bool(r.is_active),
  }));

  const participantsByMatch = new Map();
  for (const r of d.prepare(
    `SELECT match_id, player_id, team_side, team_id, participant_order
     FROM match_participants ORDER BY team_side, participant_order`
  ).all()) {
    const list = participantsByMatch.get(r.match_id) ?? [];
    list.push({
      playerId: r.player_id, teamSide: r.team_side,
      teamId: r.team_id, participantOrder: r.participant_order,
    });
    participantsByMatch.set(r.match_id, list);
  }

  const matches = d.prepare(
    `SELECT id, league_id, match_date, court_id, location_id, scoring_type, game_type,
            team_a_id, team_b_id, score_a, score_b, created_at
     FROM matches
     ORDER BY match_date DESC, created_at DESC`
  ).all().map((r) => ({
    id: r.id, leagueId: r.league_id, matchDate: r.match_date, courtId: r.court_id,
    locationId: r.location_id,
    scoringType: r.scoring_type, gameType: r.game_type,
    teamAId: r.team_a_id, teamBId: r.team_b_id,
    scoreA: r.score_a, scoreB: r.score_b, createdAt: r.created_at,
    participants: participantsByMatch.get(r.id) ?? [],
  }));

  return { leagues, teams, courts, locations, teamLeagues, players, matches };
}
