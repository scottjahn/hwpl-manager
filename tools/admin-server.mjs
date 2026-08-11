// Local-only admin API for the HWPL weekly data update.
//
// Binds to 127.0.0.1 only — never reachable from the network. Vite proxies
// /api/* here during `npm run dev` so the React admin panel works against the
// live SQLite database. It is NOT deployed; the public site is fully static.
//
// Run:     npm run dev         (starts this alongside Vite)
//          npm run dev:api     (this server alone, for debugging)

import express from 'express';
import { getDb, newId, loadRaw, defaultLocationId, DB_PATH } from './db.mjs';
import { computeAll, computeSession, buildIndexes } from './stats.mjs';

const PORT = Number(process.env.HWPL_ADMIN_PORT ?? 8787);
const app = express();
app.use(express.json());

// ─── helpers ────────────────────────────────────────────────────────────────

const send = (res, data, status = 200) => res.status(status).json(data);
const fail = (res, msg, status = 400) => res.status(status).json({ error: msg, message: msg });

const bool = (v) => !!v;

// Simple CSV serialiser matching the original api/src/lib/csv.js behaviour.
const escapeCell = (v) => {
  const s = String(v ?? '');
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) =>
  [header, ...rows].map((r) => r.map(escapeCell).join(',')).join('\n') + '\n';

// ─── /.auth/me stub (Azure SWA compatibility) ────────────────────────────────
// AdminPage calls this to display the signed-in Entra object ID; silently
// falls back to "" on failure. Return a local placeholder so the debug panel
// shows something useful.

app.get('/.auth/me', (_req, res) => {
  send(res, [
    {
      userId: 'local-admin',
      userDetails: 'local-admin',
      identityProvider: 'local',
      userRoles: ['authenticated', 'hwpl-admin'],
      claims: [{ typ: 'oid', val: 'local-admin' }],
    },
  ]);
});

// ─── auth stubs ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  send(res, { ok: true, service: 'hwpl-local-admin' });
});

app.get('/api/debug/auth', (_req, res) => {
  send(res, {
    isAuthenticated: true,
    isAdmin: true,
    objectId: 'local-admin',
    candidateIds: ['local-admin'],
    principalName: 'local-admin',
    roles: ['hwpl-admin'],
  });
});

app.get('/api/ops/me', (_req, res) => {
  send(res, { isAdmin: true, objectId: 'local-admin', candidateIds: ['local-admin'] });
});

app.get('/api/ops/diagnostics', (_req, res) => {
  send(res, { version: 'hwpl-local-admin-v1', timestamp: new Date().toISOString() });
});

// ─── stats (read-only, computed from SQLite) ─────────────────────────────────
// These mirror the public /api/stats/* Azure Functions so the admin panel's
// entity pickers (leagues, teams, courts, players) are always up to date.

const withStats = async (res, fn) => {
  try {
    const raw = loadRaw();
    const all = computeAll(raw);
    fn(raw, all);
  } catch (e) {
    console.error(e);
    fail(res, String(e), 500);
  }
};

app.get('/api/stats/players', (_req, res) => {
  withStats(res, (_raw, all) => send(res, all.players));
});

app.get('/api/stats/teams', (_req, res) => {
  withStats(res, (_raw, all) => send(res, all.teams));
});

app.get('/api/stats/matches', (_req, res) => {
  withStats(res, (_raw, all) => send(res, all.matches));
});

app.get('/api/stats/matches-full', (_req, res) => {
  withStats(res, (_raw, all) => send(res, all.matchesFull));
});

app.get('/api/stats/leagues', (_req, res) => {
  withStats(res, (_raw, all) => send(res, all.leagues));
});

app.get('/api/stats/session-dates', (_req, res) => {
  withStats(res, (_raw, all) => send(res, all.sessionDates));
});

app.get('/api/stats/session', (req, res) => {
  const date = req.query.date;
  if (!date) return fail(res, "Missing query param: date");
  try {
    const raw = loadRaw();
    const idx = buildIndexes(raw);
    send(res, computeSession(raw, idx, date));
  } catch (e) {
    console.error(e);
    fail(res, String(e), 500);
  }
});

// ─── Admin CRUD helpers ───────────────────────────────────────────────────────

// Load all lookup tables from SQLite for name resolution in match listing.
function loadLookups(d = getDb()) {
  const rows = (q) => d.prepare(q).all();
  const mapBy = (q, key = 'id') => new Map(rows(q).map((r) => [r[key], r]));

  return {
    leagueById: mapBy('SELECT id, name, start_date FROM leagues'),
    courtById: mapBy('SELECT id, name FROM courts'),
    locationById: mapBy('SELECT id, name, address FROM locations'),
    teamById: mapBy('SELECT id, name FROM teams'),
    playerById: mapBy('SELECT id, first_name, last_name, dupr_id FROM players'),
    teamLeagues: rows('SELECT team_id, league_id FROM team_leagues'),
    partsByMatch: (() => {
      const m = new Map();
      for (const r of rows('SELECT match_id, player_id, team_side, team_id, participant_order FROM match_participants')) {
        const list = m.get(r.match_id) ?? [];
        list.push(r);
        m.set(r.match_id, list);
      }
      return m;
    })(),
  };
}

const fullName = (p) => `${p.first_name} ${p.last_name}`;

// Build the admin-list match shape the AdminPage expects.
function buildMatchListItem(m, lk) {
  const { leagueById, courtById, locationById, teamById, playerById, partsByMatch } = lk;
  const parts = partsByMatch.get(m.id) ?? [];
  const getPart = (side, order) => parts.find((p) => p.team_side === side && p.participant_order === order);
  const pA1 = getPart('A', 1); const pA2 = getPart('A', 2);
  const pB1 = getPart('B', 1); const pB2 = getPart('B', 2);

  const pName = (p) => p ? (fullName(playerById.get(p.player_id) ?? { first_name: '?', last_name: '' })) : '';
  const firstName = (p) => p ? (playerById.get(p.player_id)?.first_name ?? '?') : '?';

  const league = leagueById.get(m.league_id);
  const ladderSide = (p1, p2) =>
    [p1, p2].filter(Boolean).map(firstName).join(' & ') || 'Ladder Side';

  return {
    id: m.id,
    leagueId: m.league_id,
    courtId: m.court_id,
    locationId: m.location_id ?? '',
    scoringType: m.scoring_type,
    gameType: m.game_type,
    date: m.match_date,
    teamAId: m.team_a_id ?? '',
    teamBId: m.team_b_id ?? '',
    scoreA: m.score_a,
    scoreB: m.score_b,
    leagueName: league ? `${league.name} (${league.start_date})` : '',
    courtName: courtById.get(m.court_id)?.name ?? '',
    locationName: locationById.get(m.location_id)?.name ?? '',
    teamAName: m.game_type === 'Ladder'
      ? ladderSide(pA1, pA2)
      : (teamById.get(m.team_a_id)?.name ?? 'Ladder Side A'),
    teamBName: m.game_type === 'Ladder'
      ? ladderSide(pB1, pB2)
      : (teamById.get(m.team_b_id)?.name ?? 'Ladder Side B'),
    teamAPlayers: [pA1?.player_id ?? '', pA2?.player_id ?? ''],
    teamBPlayers: [pB1?.player_id ?? '', pB2?.player_id ?? ''],
    teamAPlayerNames: [pName(pA1), pName(pA2)],
    teamBPlayerNames: [pName(pB1), pName(pB2)],
  };
}

// ─── Players ─────────────────────────────────────────────────────────────────

app.get('/api/ops/players', (_req, res) => {
  try {
    const rows = getDb().prepare(
      `SELECT id, first_name AS firstName, last_name AS lastName,
              dupr_id AS duprId, default_team_id AS defaultTeamId, is_active AS isActive
       FROM players ORDER BY first_name, last_name`
    ).all().map((r) => ({ ...r, isActive: bool(r.isActive) }));
    send(res, rows);
  } catch (e) { fail(res, String(e), 500); }
});

app.post('/api/ops/players', (req, res) => {
  try {
    const { firstName, lastName, duprId, defaultTeamId, isActive } = req.body ?? {};
    if (!firstName || !lastName || !duprId) return fail(res, 'Fields firstName, lastName, duprId are required.');
    const id = newId();
    getDb().prepare(
      `INSERT INTO players (id, first_name, last_name, dupr_id, default_team_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, firstName, lastName, duprId, defaultTeamId || null, isActive !== false ? 1 : 0);
    send(res, { id }, 201);
  } catch (e) { fail(res, String(e), 500); }
});

app.put('/api/ops/players/:id', (req, res) => {
  try {
    const { firstName, lastName, duprId, defaultTeamId, isActive } = req.body ?? {};
    const r = getDb().prepare(
      `UPDATE players SET first_name=?, last_name=?, dupr_id=?, default_team_id=?, is_active=? WHERE id=?`
    ).run(firstName, lastName, duprId, defaultTeamId || null, isActive !== false ? 1 : 0, req.params.id);
    if (r.changes === 0) return fail(res, 'Player not found.', 404);
    send(res, { updated: true });
  } catch (e) { fail(res, String(e), 500); }
});

app.delete('/api/ops/players/:id', (req, res) => {
  try {
    getDb().prepare(`UPDATE players SET is_active=0 WHERE id=?`).run(req.params.id);
    send(res, { deactivated: true });
  } catch (e) { fail(res, String(e), 500); }
});

// ─── Courts ──────────────────────────────────────────────────────────────────

app.get('/api/ops/courts', (_req, res) => {
  try {
    const rows = getDb().prepare(
      `SELECT id, name, is_active AS isActive FROM courts ORDER BY name`
    ).all().map((r) => ({ ...r, isActive: bool(r.isActive) }));
    send(res, rows);
  } catch (e) { fail(res, String(e), 500); }
});

app.post('/api/ops/courts', (req, res) => {
  try {
    const { name, isActive } = req.body ?? {};
    if (!name) return fail(res, 'Field name is required.');
    const id = newId();
    getDb().prepare(`INSERT INTO courts (id, name, is_active) VALUES (?, ?, ?)`
    ).run(id, name, isActive !== false ? 1 : 0);
    send(res, { id }, 201);
  } catch (e) { fail(res, String(e), 500); }
});

app.put('/api/ops/courts/:id', (req, res) => {
  try {
    const { name, isActive } = req.body ?? {};
    const r = getDb().prepare(`UPDATE courts SET name=?, is_active=? WHERE id=?`
    ).run(name, isActive !== false ? 1 : 0, req.params.id);
    if (r.changes === 0) return fail(res, 'Court not found.', 404);
    send(res, { updated: true });
  } catch (e) { fail(res, String(e), 500); }
});

app.delete('/api/ops/courts/:id', (req, res) => {
  try {
    getDb().prepare(`UPDATE courts SET is_active=0 WHERE id=?`).run(req.params.id);
    send(res, { deactivated: true });
  } catch (e) { fail(res, String(e), 500); }
});

// ─── Locations ───────────────────────────────────────────────────────────────
// Venues. At most one location is the default (enforced by a partial unique
// index); the match form pre-selects it for new matches.

// Clears the flag everywhere else so `id` can become the only default.
const clearOtherDefaults = (d, id) =>
  d.prepare(`UPDATE locations SET is_default=0 WHERE id<>?`).run(id);

app.get('/api/ops/locations', (_req, res) => {
  try {
    const rows = getDb().prepare(
      `SELECT id, name, address, is_default AS isDefault, is_active AS isActive
       FROM locations ORDER BY is_default DESC, name`
    ).all().map((r) => ({ ...r, isDefault: bool(r.isDefault), isActive: bool(r.isActive) }));
    send(res, rows);
  } catch (e) { fail(res, String(e), 500); }
});

app.post('/api/ops/locations', (req, res) => {
  try {
    const { name, address, isDefault, isActive } = req.body ?? {};
    if (!name) return fail(res, 'Field name is required.');
    const d = getDb();
    const id = newId();
    // The very first location is the default whether or not the caller says so.
    const makeDefault = isDefault === true || d.prepare(`SELECT COUNT(*) AS n FROM locations`).get().n === 0;
    d.transaction(() => {
      if (makeDefault) clearOtherDefaults(d, id);
      d.prepare(
        `INSERT INTO locations (id, name, address, is_default, is_active) VALUES (?, ?, ?, ?, ?)`
      ).run(id, name, address ?? '', makeDefault ? 1 : 0, isActive !== false ? 1 : 0);
    })();
    send(res, { id }, 201);
  } catch (e) { fail(res, String(e), 500); }
});

app.put('/api/ops/locations/:id', (req, res) => {
  try {
    const { name, address, isDefault, isActive } = req.body ?? {};
    const d = getDb();
    const id = req.params.id;
    d.transaction(() => {
      if (isDefault === true) clearOtherDefaults(d, id);
      const r = d.prepare(
        `UPDATE locations SET name=?, address=?, is_default=?, is_active=? WHERE id=?`
      ).run(name, address ?? '', isDefault === true ? 1 : 0, isActive !== false ? 1 : 0, id);
      if (r.changes === 0) throw Object.assign(new Error('Location not found.'), { code: 404 });
    })();
    send(res, { updated: true });
  } catch (e) {
    if (e.code === 404) return fail(res, e.message, 404);
    fail(res, String(e), 500);
  }
});

app.delete('/api/ops/locations/:id', (req, res) => {
  try {
    getDb().prepare(`UPDATE locations SET is_active=0 WHERE id=?`).run(req.params.id);
    send(res, { deactivated: true });
  } catch (e) { fail(res, String(e), 500); }
});

// ─── Leagues ─────────────────────────────────────────────────────────────────

app.get('/api/ops/leagues', (_req, res) => {
  try {
    const rows = getDb().prepare(
      `SELECT id, name, start_date AS startDate, end_date AS endDate, is_active AS isActive
       FROM leagues ORDER BY start_date DESC, name`
    ).all().map((r) => ({ ...r, isActive: bool(r.isActive) }));
    send(res, rows);
  } catch (e) { fail(res, String(e), 500); }
});

app.post('/api/ops/leagues', (req, res) => {
  try {
    const { name, startDate, endDate, isActive } = req.body ?? {};
    if (!name) return fail(res, 'Field name is required.');
    if (!startDate) return fail(res, "Field 'startDate' is required.");
    if (!endDate) return fail(res, "Field 'endDate' is required.");
    if (endDate < startDate) return fail(res, "Field 'endDate' cannot be earlier than 'startDate'.");
    const id = newId();
    getDb().prepare(
      `INSERT INTO leagues (id, name, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?)`
    ).run(id, name, startDate, endDate, isActive !== false ? 1 : 0);
    send(res, { id }, 201);
  } catch (e) { fail(res, String(e), 500); }
});

app.put('/api/ops/leagues/:id', (req, res) => {
  try {
    const { name, startDate, endDate, isActive } = req.body ?? {};
    if (!startDate) return fail(res, "Field 'startDate' is required.");
    if (!endDate) return fail(res, "Field 'endDate' is required.");
    if (endDate < startDate) return fail(res, "Field 'endDate' cannot be earlier than 'startDate'.");
    const r = getDb().prepare(
      `UPDATE leagues SET name=?, start_date=?, end_date=?, is_active=? WHERE id=?`
    ).run(name, startDate, endDate, isActive !== false ? 1 : 0, req.params.id);
    if (r.changes === 0) return fail(res, 'League not found.', 404);
    send(res, { updated: true });
  } catch (e) { fail(res, String(e), 500); }
});

app.delete('/api/ops/leagues/:id', (req, res) => {
  try {
    getDb().prepare(`UPDATE leagues SET is_active=0 WHERE id=?`).run(req.params.id);
    send(res, { deactivated: true });
  } catch (e) { fail(res, String(e), 500); }
});

// ─── Teams ────────────────────────────────────────────────────────────────────

app.get('/api/ops/teams', (_req, res) => {
  try {
    const d = getDb();
    const teams = d.prepare(`SELECT id, name, is_active AS isActive FROM teams ORDER BY name`)
      .all().map((r) => ({ ...r, isActive: bool(r.isActive) }));
    const tl = d.prepare(`SELECT team_id, league_id FROM team_leagues`).all();
    const leagueIdsByTeam = new Map();
    for (const { team_id, league_id } of tl) {
      const arr = leagueIdsByTeam.get(team_id) ?? [];
      arr.push(league_id);
      leagueIdsByTeam.set(team_id, arr);
    }
    send(res, teams.map((t) => ({ ...t, leagueIds: leagueIdsByTeam.get(t.id) ?? [] })));
  } catch (e) { fail(res, String(e), 500); }
});

app.post('/api/ops/teams', (req, res) => {
  try {
    const { name, isActive, leagueIds } = req.body ?? {};
    if (!name) return fail(res, 'Field name is required.');
    const d = getDb();
    const id = newId();
    const insertTeam = d.prepare(`INSERT INTO teams (id, name, is_active) VALUES (?, ?, ?)`);
    const insertTL = d.prepare(`INSERT OR IGNORE INTO team_leagues (team_id, league_id) VALUES (?, ?)`);
    d.transaction(() => {
      insertTeam.run(id, name, isActive !== false ? 1 : 0);
      for (const lid of (leagueIds ?? [])) insertTL.run(id, lid);
    })();
    send(res, { id }, 201);
  } catch (e) { fail(res, String(e), 500); }
});

app.put('/api/ops/teams/:id', (req, res) => {
  try {
    const { name, isActive, leagueIds } = req.body ?? {};
    const d = getDb();
    const id = req.params.id;
    const insertTL = d.prepare(`INSERT OR IGNORE INTO team_leagues (team_id, league_id) VALUES (?, ?)`);
    d.transaction(() => {
      const r = d.prepare(`UPDATE teams SET name=?, is_active=? WHERE id=?`
      ).run(name, isActive !== false ? 1 : 0, id);
      if (r.changes === 0) throw Object.assign(new Error('Team not found.'), { code: 404 });
      if (Array.isArray(leagueIds)) {
        d.prepare(`DELETE FROM team_leagues WHERE team_id=?`).run(id);
        for (const lid of leagueIds) insertTL.run(id, lid);
      }
    })();
    send(res, { updated: true });
  } catch (e) {
    if (e.code === 404) return fail(res, e.message, 404);
    fail(res, String(e), 500);
  }
});

app.delete('/api/ops/teams/:id', (req, res) => {
  try {
    getDb().prepare(`UPDATE teams SET is_active=0 WHERE id=?`).run(req.params.id);
    send(res, { deactivated: true });
  } catch (e) { fail(res, String(e), 500); }
});

// ─── Matches ──────────────────────────────────────────────────────────────────

app.get('/api/ops/matches', (_req, res) => {
  try {
    const d = getDb();
    const lk = loadLookups(d);
    const matches = d.prepare(
      `SELECT id, league_id, match_date, court_id, location_id, scoring_type, game_type,
              team_a_id, team_b_id, score_a, score_b
       FROM matches ORDER BY match_date DESC, created_at DESC`
    ).all();
    send(res, matches.map((m) => buildMatchListItem(m, lk)));
  } catch (e) { fail(res, String(e), 500); }
});

// Shared match save logic (insert or update).
function saveMatch(d, payload, existingId = null) {
  const { gameType, scoringType, leagueId, courtId, locationId, date,
          teamAId, teamBId, teamAPlayers, teamBPlayers, scoreA, scoreB } = payload;

  // Validation mirrors the original Azure Function.
  if (!Array.isArray(teamAPlayers) || !Array.isArray(teamBPlayers) || teamAPlayers.length + teamBPlayers.length !== 4)
    return { error: 'A match must include exactly two players on each team.', status: 400 };
  if (new Set([...teamAPlayers, ...teamBPlayers]).size !== 4)
    return { error: 'Players in a match must be unique.', status: 400 };
  if (!courtId)
    return { error: "Field 'courtId' is required.", status: 400 };
  if (gameType === 'Doubles' && (!teamAId || !teamBId || teamAId === teamBId))
    return { error: 'Doubles matches must include two distinct teams.', status: 400 };

  const gType = gameType === 'Ladder' ? 'Ladder' : 'Doubles';
  const sType = scoringType === 'Rally' ? 'Rally' : 'Sideout';
  // Location is defaulted, not required: callers that omit it get the default venue.
  const locId = locationId || defaultLocationId(d);
  const tA = gType === 'Doubles' ? (teamAId ?? null) : null;
  const tB = gType === 'Doubles' ? (teamBId ?? null) : null;
  const matchId = existingId ?? newId();

  const insertPart = d.prepare(
    `INSERT INTO match_participants (match_id, player_id, team_side, team_id, participant_order)
     VALUES (?, ?, ?, ?, ?)`
  );

  d.transaction(() => {
    if (existingId) {
      const r = d.prepare(
        `UPDATE matches SET league_id=?, match_date=?, court_id=?, location_id=?, scoring_type=?, game_type=?,
                            team_a_id=?, team_b_id=?, score_a=?, score_b=? WHERE id=?`
      ).run(leagueId, date, courtId, locId, sType, gType, tA, tB, scoreA, scoreB, existingId);
      if (r.changes === 0) throw Object.assign(new Error('Match not found.'), { code: 404 });
      d.prepare(`DELETE FROM match_participants WHERE match_id=?`).run(existingId);
    } else {
      d.prepare(
        `INSERT INTO matches (id, league_id, match_date, court_id, location_id, scoring_type, game_type,
                              team_a_id, team_b_id, score_a, score_b)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(matchId, leagueId, date, courtId, locId, sType, gType, tA, tB, scoreA, scoreB);
    }
    for (let i = 0; i < teamAPlayers.length; i++)
      insertPart.run(matchId, teamAPlayers[i], 'A', tA, i + 1);
    for (let i = 0; i < teamBPlayers.length; i++)
      insertPart.run(matchId, teamBPlayers[i], 'B', tB, i + 1);
  })();

  return { id: matchId };
}

app.post('/api/ops/matches', (req, res) => {
  try {
    const result = saveMatch(getDb(), req.body ?? {});
    if (result.error) return fail(res, result.error, result.status);
    send(res, result, 201);
  } catch (e) { fail(res, String(e), 500); }
});

app.put('/api/ops/matches/:id', (req, res) => {
  try {
    const result = saveMatch(getDb(), req.body ?? {}, req.params.id);
    if (result.error) return fail(res, result.error, result.status);
    send(res, result);
  } catch (e) {
    if (e.code === 404) return fail(res, e.message, 404);
    fail(res, String(e), 500);
  }
});

app.delete('/api/ops/matches/:id', (req, res) => {
  try {
    // ON DELETE CASCADE handles match_participants automatically.
    const r = getDb().prepare(`DELETE FROM matches WHERE id=?`).run(req.params.id);
    if (r.changes === 0) return fail(res, 'Match not found.', 404);
    send(res, { deleted: true });
  } catch (e) { fail(res, String(e), 500); }
});

// ─── DUPR export ──────────────────────────────────────────────────────────────
// The 27-column DUPR single-match import format: per-player external IDs, the
// venue in a trailing `location` column, and scoreType moved to the last column.
// Only includes matches with a decisive score (no ties, score > 5 for at least one side).

app.get('/api/exports/dupr/dates', (_req, res) => {
  try {
    const dates = getDb().prepare(
      `SELECT DISTINCT match_date AS matchDate FROM matches
       WHERE game_type IN ('Doubles','Ladder')
         AND score_a <> score_b
         AND (score_a > 5 OR score_b > 5)
       ORDER BY match_date DESC`
    ).all().map((r) => r.matchDate);
    send(res, dates);
  } catch (e) { fail(res, String(e), 500); }
});

app.get('/api/exports/dupr', (req, res) => {
  const date = req.query.date;
  if (!date) return fail(res, "Query parameter 'date' is required.");

  try {
    const d = getDb();
    const lk = loadLookups(d);

    const matches = d.prepare(
      `SELECT id, league_id, court_id, location_id, scoring_type, game_type, match_date, score_a, score_b
       FROM matches
       WHERE match_date = ?
         AND game_type IN ('Doubles','Ladder')
         AND score_a <> score_b
         AND (score_a > 5 OR score_b > 5)
       ORDER BY created_at`
    ).all(date);

    if (matches.length === 0)
      return fail(res, `No eligible matches found for ${date}.`);

    const getPart = (matchId, side, order) =>
      (lk.partsByMatch.get(matchId) ?? [])
        .find((p) => p.team_side === side && p.participant_order === order);

    const header = [
      'matchType', 'event', 'date',
      'playerA1', 'playerA1DuprId', 'playerA1ExternalId',
      'playerA2', 'playerA2DuprId', 'playerA2ExternalId',
      'playerB1', 'playerB1DuprId', 'playerB1ExternalId',
      'playerB2', 'playerB2DuprId', 'playerB2ExternalId',
      'teamAGame1', 'teamBGame1', 'teamAGame2', 'teamBGame2',
      'teamAGame3', 'teamBGame3', 'teamAGame4', 'teamBGame4', 'teamAGame5', 'teamBGame5',
      'location', 'scoreType',
    ];

    const rows = matches.map((m) => {
      const pA1 = getPart(m.id, 'A', 1); const pA2 = getPart(m.id, 'A', 2);
      const pB1 = getPart(m.id, 'B', 1); const pB2 = getPart(m.id, 'B', 2);

      // externalId is left blank — HWPL players carry no DUPR-side external ID.
      const pRow = (p) => {
        if (!p) return ['', '', ''];
        const pl = lk.playerById.get(p.player_id);
        return [pl ? fullName(pl) : '', pl?.dupr_id ?? '', ''];
      };

      const league = lk.leagueById.get(m.league_id);
      const court = lk.courtById.get(m.court_id);
      const event = `${league?.name ?? ''} - ${m.match_date} - ${court?.name ?? 'Unassigned Court'}`;

      const loc = lk.locationById.get(m.location_id);
      const location = [loc?.name, loc?.address].filter(Boolean).join(', ');

      return [
        'D',
        event,
        m.match_date,
        ...pRow(pA1), ...pRow(pA2), ...pRow(pB1), ...pRow(pB2),
        m.score_a, m.score_b, '', '', '', '', '', '', '', '',
        location,
        m.scoring_type.toUpperCase(),
      ];
    });

    const csv = toCsv(header, rows);
    res
      .status(200)
      .set('Content-Type', 'text/csv')
      .set('Content-Disposition', `attachment; filename="hwpl-dupr-export-${date}.csv"`)
      .send(csv);
  } catch (e) {
    console.error(e);
    fail(res, String(e), 500);
  }
});

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`HWPL admin server → http://127.0.0.1:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Kill the other process or set HWPL_ADMIN_PORT.`);
  } else {
    throw e;
  }
});
