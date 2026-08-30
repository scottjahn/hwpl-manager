-- HWPL schema (SQLite port of database/schema.sql).
--
-- IDs are TEXT UUIDs (the frontend treats every id as a string and builds
-- /team/<id> and /player/<id> routes from them), generated in JS on insert.
-- This is the local source of truth, edited weekly and exported to static JSON.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leagues (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  start_date   TEXT    NOT NULL,            -- ISO date (YYYY-MM-DD)
  end_date     TEXT    NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,  -- 0/1
  -- Optional announcement shown under the league picker on the public stats
  -- page. Raw HTML, authored by the admin in the local admin panel.
  message_html TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courts (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Venues. Courts (East/West/Middle) live inside a location; each match records
-- where it was played. Exactly one row may carry is_default = 1 — the match form
-- pre-selects it, and tools/db.mjs seeds the club's home venue on first run.
CREATE TABLE IF NOT EXISTS locations (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  address    TEXT    NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,  -- 0/1
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Teams can belong to more than one league.
CREATE TABLE IF NOT EXISTS team_leagues (
  team_id   TEXT NOT NULL REFERENCES teams(id),
  league_id TEXT NOT NULL REFERENCES leagues(id),
  PRIMARY KEY (team_id, league_id)
);

CREATE TABLE IF NOT EXISTS players (
  id              TEXT    PRIMARY KEY,
  first_name      TEXT    NOT NULL,
  last_name       TEXT    NOT NULL,
  dupr_id         TEXT    NOT NULL,
  default_team_id TEXT    REFERENCES teams(id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT    PRIMARY KEY,
  league_id    TEXT    NOT NULL REFERENCES leagues(id),
  match_date   TEXT    NOT NULL,          -- ISO date
  court_id     TEXT    REFERENCES courts(id),
  location_id  TEXT    REFERENCES locations(id),
  scoring_type TEXT    NOT NULL DEFAULT 'Sideout',
  game_type    TEXT    NOT NULL DEFAULT 'Doubles',
  team_a_id    TEXT    REFERENCES teams(id),
  team_b_id    TEXT    REFERENCES teams(id),
  score_a      INTEGER NOT NULL,
  score_b      INTEGER NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (score_a <> score_b),
  CHECK (scoring_type IN ('Sideout', 'Rally')),
  CHECK (game_type IN ('Doubles', 'Ladder')),
  CHECK (
    (game_type = 'Doubles' AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL AND team_a_id <> team_b_id)
    OR
    (game_type = 'Ladder' AND team_a_id IS NULL AND team_b_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS match_participants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id          TEXT    NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id         TEXT    NOT NULL REFERENCES players(id),
  team_side         TEXT    NOT NULL,
  team_id           TEXT    REFERENCES teams(id),
  participant_order INTEGER NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (team_side IN ('A', 'B')),
  CHECK (participant_order IN (1, 2))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_players_dupr_id   ON players(dupr_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_courts_name       ON courts(name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_locations_name    ON locations(name);
-- Partial unique index: at most one default location.
CREATE UNIQUE INDEX IF NOT EXISTS ux_locations_default ON locations(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mp_unique_player  ON match_participants(match_id, player_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mp_slot           ON match_participants(match_id, team_side, participant_order);
CREATE INDEX IF NOT EXISTS ix_matches_league_date      ON matches(league_id, match_date);
CREATE INDEX IF NOT EXISTS ix_matches_court_date       ON matches(court_id, match_date);
CREATE INDEX IF NOT EXISTS ix_mp_player                ON match_participants(player_id);
