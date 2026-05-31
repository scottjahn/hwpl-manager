// Build-time export: dump SQLite to the static JSON the deployed site fetches.
// Run locally after each weekly update, then commit public/data so Cloudflare
// Pages can build without the database.
//
//   npm run export

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRaw } from './db.mjs';
import { computeAll } from './stats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data', 'stats');

const write = (relPath, data) => {
  const file = join(OUT, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data) + '\n');
};

const raw = loadRaw();
const all = computeAll(raw);

// Start clean so deleted sessions/dates don't linger as stale files.
rmSync(OUT, { recursive: true, force: true });

write('players.json', all.players);
write('teams.json', all.teams);
write('matches.json', all.matches);
write('matches-full.json', all.matchesFull);
write('leagues.json', all.leagues);
write('session-dates.json', all.sessionDates);
for (const [date, session] of Object.entries(all.sessions)) {
  write(join('session', `${date}.json`), session);
}

console.log(
  `Exported -> ${OUT}\n` +
  `  ${all.players.length} players, ${all.teams.length} teams, ` +
  `${all.matchesFull.length} matches, ${all.sessionDates.length} session date(s)`
);
