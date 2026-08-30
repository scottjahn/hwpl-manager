// Build-time export: dump SQLite to the static JSON the deployed site fetches.
// Run locally after each weekly update, then commit public/data so the GitHub
// Pages workflow can build without the database.
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

// Start clean so files from an earlier export don't linger as stale.
rmSync(OUT, { recursive: true, force: true });

// The public site derives every table (players, teams, sessions, recent
// matches) in the browser from these two files, so they are all it needs.
write('matches-full.json', all.matchesFull);
write('leagues.json', all.leagues);

console.log(
  `Exported -> ${OUT}\n` +
  `  ${all.matchesFull.length} matches across ${all.leagues.length} league(s)`
);
