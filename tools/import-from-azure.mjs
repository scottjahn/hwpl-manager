// One-time import: load Azure SQL data into the local SQLite database.
//
// STEP 1 — Export from Azure SQL (choose one method):
//
//   A) Azure Data Studio → right-click each table → "Select Top 1000 Rows",
//      then "Save Results As JSON". Or run:
//        SELECT * FROM leagues FOR JSON AUTO, WITHOUT_ARRAY_WRAPPER=OFF
//      and save each result to a .json file.
//
//   B) sqlpackage extract/export to BACPAC:
//        sqlpackage /a:Export /tf:hwpl.bacpac /scs:"Server=...;Database=...;..."
//      A .bacpac is a ZIP. Unzip it, then `data/` contains CSV files named
//      `dbo.leagues.csv`, `dbo.teams.csv`, etc.
//
//   C) bcp utility (installed with mssql-tools or SQL Server):
//        bcp "SELECT * FROM leagues" queryout leagues.json -S ... -U ... -P ... -c
//
// STEP 2 — Place the exported JSON files in a directory, then run:
//
//   HWPL_IMPORT_DIR=./import-data node tools/import-from-azure.mjs
//
// Expected files in HWPL_IMPORT_DIR (camelCase keys as exported by FOR JSON AUTO):
//   leagues.json, teams.json, courts.json, team_leagues.json,
//   players.json, matches.json, match_participants.json
//
// SAFE TO RE-RUN: it aborts if the database already contains data unless
// you pass --force, which truncates everything first.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, newId } from './db.mjs';

// Parse --dir <path> from argv, falling back to env var then default.
const dirFlagIdx = process.argv.indexOf('--dir');
const DIR = dirFlagIdx !== -1
  ? process.argv[dirFlagIdx + 1]
  : (process.env.HWPL_IMPORT_DIR ?? './import-data');
const FORCE = process.argv.includes('--force');

const d = getDb();

// ─── safety check ────────────────────────────────────────────────────────────

const existing = d.prepare('SELECT COUNT(*) AS n FROM leagues').get().n;
if (existing > 0 && !FORCE) {
  console.error(
    `Database already has ${existing} league(s). ` +
    'Run with --force to wipe and reimport, or delete data/hwpl.db manually.'
  );
  process.exit(1);
}

if (FORCE && existing > 0) {
  d.exec(`
    DELETE FROM match_participants;
    DELETE FROM matches;
    DELETE FROM players;
    DELETE FROM team_leagues;
    DELETE FROM teams;
    DELETE FROM courts;
    DELETE FROM leagues;
  `);
  console.log('Cleared existing data (--force).');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// Azure's FOR JSON AUTO uses the original column names (snake_case). If your
// export uses camelCase column aliases (e.g. `start_date AS startDate`), the
// mapping below handles both.
const read = (name) => {
  const paths = [
    join(DIR, `${name}.csv`),        // plain CSV from Azure Portal "Download" button
    join(DIR, `dbo.${name}.csv`),    // BACPAC-style CSV
    join(DIR, `${name}.json`),       // JSON (only works if it's a real JSON array, not FOR JSON AUTO output)
  ];
  for (const p of paths) {
    try {
      const content = readFileSync(p, 'utf8').trim();
      if (p.endsWith('.csv')) return parseCsv(content);
      // Detect the Azure Portal "FOR JSON AUTO" chunked format:
      // the file is an array of objects with a single GUID-named key containing JSON fragments.
      const parsed = JSON.parse(content);
      if (
        Array.isArray(parsed) && parsed.length > 0 &&
        typeof parsed[0] === 'object' &&
        Object.keys(parsed[0]).length === 1 &&
        /^JSON_[0-9A-F-]+$/i.test(Object.keys(parsed[0])[0])
      ) {
        // Reassemble the chunked JSON and parse it properly.
        const key = Object.keys(parsed[0])[0];
        const joined = parsed.map((r) => r[key]).join('');
        return JSON.parse(joined);
      }
      return parsed;
    } catch { /* try next */ }
  }
  console.warn(`  WARNING: ${name}.csv / ${name}.json not found in ${DIR} — skipping.`);
  return [];
};

// Minimal RFC-4180 CSV parser for the BACPAC format (no newlines in fields).
function parseCsv(text) {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length < 2) return [];
  const cols = splitCsvRow(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitCsvRow(line);
    return Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? '']));
  });
}
function splitCsvRow(line) {
  const cells = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (line[i] === ',' && !inQ) { cells.push(cur); cur = ''; }
    else { cur += line[i]; }
  }
  cells.push(cur);
  return cells;
}

// Coerce a value to an Azure-style boolean (1/0 in SQL, true/false in JSON).
const asBit = (v) => (v === 1 || v === true || v === '1' || v === 'True') ? 1 : 0;
// Azure SQL dates come as ISO strings; just take the YYYY-MM-DD part.
const asDate = (v) => (v ?? '').slice(0, 10);

// Azure SQL UUIDs are uppercase; lowercase for consistency with our generated IDs.
// Returns null (not a random UUID) when the value is missing — callers handle null.
const asId = (v) => {
  const s = (v ?? '').toString().toLowerCase().trim();
  return s || null;
};

// ─── import ───────────────────────────────────────────────────────────────────

const doImport = d.transaction(() => {
  // Leagues
  const leagues = read('leagues');
  const iLeague = d.prepare(
    `INSERT OR IGNORE INTO leagues (id, name, start_date, end_date, is_active) VALUES (?,?,?,?,?)`
  );
  for (const r of leagues) {
    iLeague.run(
      asId(r.id), r.name, asDate(r.start_date ?? r.startDate),
      asDate(r.end_date ?? r.endDate ?? r.start_date ?? r.startDate),
      asBit(r.is_active ?? r.isActive)
    );
  }
  console.log(`  leagues: ${leagues.length}`);

  // Courts
  const courts = read('courts');
  const iCourt = d.prepare(`INSERT OR IGNORE INTO courts (id, name, is_active) VALUES (?,?,?)`);
  for (const r of courts) iCourt.run(asId(r.id), r.name, asBit(r.is_active ?? r.isActive));
  console.log(`  courts: ${courts.length}`);

  // Teams
  const teams = read('teams');
  const iTeam = d.prepare(`INSERT OR IGNORE INTO teams (id, name, is_active) VALUES (?,?,?)`);
  for (const r of teams) iTeam.run(asId(r.id), r.name, asBit(r.is_active ?? r.isActive));
  console.log(`  teams: ${teams.length}`);

  // team_leagues junction
  const teamLeagues = read('team_leagues');
  if (teamLeagues.length > 0) {
    console.log(`  team_leagues fields: ${Object.keys(teamLeagues[0]).join(', ')}`);
  }
  const iTL = d.prepare(`INSERT OR IGNORE INTO team_leagues (team_id, league_id) VALUES (?,?)`);
  let tlSkipped = 0;
  for (const r of teamLeagues) {
    // Accept any plausible column name variant from different export tools.
    const tid = asId(r.team_id ?? r.teamId ?? r.TeamId ?? r.TEAM_ID);
    const lid = asId(r.league_id ?? r.leagueId ?? r.LeagueId ?? r.LEAGUE_ID);
    if (!tid || !lid) { tlSkipped++; continue; }
    iTL.run(tid, lid);
  }
  if (tlSkipped > 0) console.warn(`  team_leagues: skipped ${tlSkipped} rows with unresolvable IDs`);
  console.log(`  team_leagues: ${teamLeagues.length - tlSkipped}`);

  // Players
  const players = read('players');
  const iPlayer = d.prepare(
    `INSERT OR IGNORE INTO players (id, first_name, last_name, dupr_id, default_team_id, is_active)
     VALUES (?,?,?,?,?,?)`
  );
  for (const r of players) {
    iPlayer.run(
      asId(r.id), r.first_name ?? r.firstName, r.last_name ?? r.lastName,
      r.dupr_id ?? r.duprId ?? '', asId(r.default_team_id ?? r.defaultTeamId),
      asBit(r.is_active ?? r.isActive)
    );
  }
  console.log(`  players: ${players.length}`);

  // Matches
  const matches = read('matches');
  const iMatch = d.prepare(
    `INSERT OR IGNORE INTO matches
       (id, league_id, match_date, court_id, scoring_type, game_type,
        team_a_id, team_b_id, score_a, score_b)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of matches) {
    const tA = r.team_a_id ?? r.teamAId; const tB = r.team_b_id ?? r.teamBId;
    iMatch.run(
      asId(r.id), asId(r.league_id ?? r.leagueId), asDate(r.match_date ?? r.matchDate),
      asId(r.court_id ?? r.courtId) || null,
      r.scoring_type ?? r.scoringType ?? 'Sideout',
      r.game_type ?? r.gameType ?? 'Doubles',
      tA ? asId(tA) : null, tB ? asId(tB) : null,
      Number(r.score_a ?? r.scoreA), Number(r.score_b ?? r.scoreB)
    );
  }
  console.log(`  matches: ${matches.length}`);

  // Match participants
  const parts = read('match_participants');
  const iPart = d.prepare(
    `INSERT OR IGNORE INTO match_participants
       (match_id, player_id, team_side, team_id, participant_order)
     VALUES (?,?,?,?,?)`
  );
  for (const r of parts) {
    const tid = r.team_id ?? r.teamId;
    iPart.run(
      asId(r.match_id ?? r.matchId), asId(r.player_id ?? r.playerId),
      r.team_side ?? r.teamSide, tid ? asId(tid) : null,
      Number(r.participant_order ?? r.participantOrder ?? 1)
    );
  }
  console.log(`  match_participants: ${parts.length}`);
});

console.log(`Importing from ${DIR} …`);
// Disable FK checks during import — the Azure data is self-consistent, but SQLite
// enforces FK constraints immediately even within a transaction, which can fail if
// parent and child rows happen to be inserted in the wrong order or with different
// UUID casing. We re-enable and verify after the import completes.
d.pragma('foreign_keys = OFF');
try {
  doImport();
} finally {
  d.pragma('foreign_keys = ON');
}

// Verify referential integrity now that all rows are loaded.
const fkViolations = d.prepare('PRAGMA foreign_key_check').all();
if (fkViolations.length > 0) {
  console.warn('WARNING: FK violations found after import:');
  for (const v of fkViolations) console.warn(' ', v);
} else {
  console.log('Import complete. No FK violations detected.');
}
console.log("Run `npm run export` to generate the static snapshot.");
