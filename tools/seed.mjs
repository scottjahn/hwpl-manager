// Seed the local SQLite database with demo data for development.
//   npm run seed
// Safe to re-run: it skips seeding if any league already exists.

import { getDb, newId, defaultLocationId } from './db.mjs';

const d = getDb();
// getDb() seeds the club's home venue on first open.
const locationId = defaultLocationId(d);

if (d.prepare('SELECT COUNT(*) AS n FROM leagues').get().n > 0) {
  console.log('Database already has data — skipping seed.');
  process.exit(0);
}

const seed = d.transaction(() => {
  const leagueId = newId();
  d.prepare(
    `INSERT INTO leagues (id, name, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 1)`
  ).run(leagueId, 'Spring 2026', '2026-03-01', '2026-06-01');

  const courts = ['Court 1', 'Court 2'].map((name) => {
    const id = newId();
    d.prepare(`INSERT INTO courts (id, name, is_active) VALUES (?, ?, 1)`).run(id, name);
    return id;
  });

  const teams = ['Smashers', 'Dinkers'].map((name) => {
    const id = newId();
    d.prepare(`INSERT INTO teams (id, name, is_active) VALUES (?, ?, 1)`).run(id, name);
    d.prepare(`INSERT INTO team_leagues (team_id, league_id) VALUES (?, ?)`).run(id, leagueId);
    return id;
  });

  // 3 players per team.
  const roster = [
    ['Alice', 'Nguyen', teams[0]],
    ['Bob', 'Martinez', teams[0]],
    ['Cara', 'Singh', teams[0]],
    ['Dan', 'OBrien', teams[1]],
    ['Eve', 'Larsson', teams[1]],
    ['Finn', 'Walsh', teams[1]],
  ];
  const players = roster.map(([first, last, team], i) => {
    const id = newId();
    d.prepare(
      `INSERT INTO players (id, first_name, last_name, dupr_id, default_team_id, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(id, first, last, `DUPR${1000 + i}`, team);
    return id;
  });

  const insertMatch = d.prepare(
    `INSERT INTO matches (id, league_id, match_date, court_id, location_id, scoring_type, game_type,
                          team_a_id, team_b_id, score_a, score_b)
     VALUES (@id, @leagueId, @matchDate, @courtId, @locationId, @scoringType, @gameType,
             @teamAId, @teamBId, @scoreA, @scoreB)`
  );
  const insertPart = d.prepare(
    `INSERT INTO match_participants (match_id, player_id, team_side, team_id, participant_order)
     VALUES (?, ?, ?, ?, ?)`
  );

  // Doubles: Smashers vs Dinkers across two dates/courts.
  const doubles = (matchDate, courtId, scoreA, scoreB) => {
    const id = newId();
    insertMatch.run({
      id, leagueId, matchDate, courtId, locationId, scoringType: 'Sideout', gameType: 'Doubles',
      teamAId: teams[0], teamBId: teams[1], scoreA, scoreB,
    });
    insertPart.run(id, players[0], 'A', teams[0], 1);
    insertPart.run(id, players[1], 'A', teams[0], 2);
    insertPart.run(id, players[3], 'B', teams[1], 1);
    insertPart.run(id, players[4], 'B', teams[1], 2);
  };
  doubles('2026-03-08', courts[0], 11, 7);
  doubles('2026-03-15', courts[1], 9, 11);

  // Ladder: ad-hoc pairs, no teams.
  const ladderId = newId();
  insertMatch.run({
    id: ladderId, leagueId, matchDate: '2026-03-15', courtId: courts[0], locationId,
    scoringType: 'Rally', gameType: 'Ladder',
    teamAId: null, teamBId: null, scoreA: 11, scoreB: 6,
  });
  insertPart.run(ladderId, players[2], 'A', null, 1);
  insertPart.run(ladderId, players[5], 'A', null, 2);
  insertPart.run(ladderId, players[0], 'B', null, 1);
  insertPart.run(ladderId, players[3], 'B', null, 2);
});

seed();
console.log('Seeded: 1 league, 2 courts, 2 teams, 6 players, 3 matches.');
