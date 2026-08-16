# Hiram Walker Pickleball League — Web App

Public statistics portal and local admin tool for the Hiram Walker Pickleball League.

## Architecture

| Layer | What it is |
|---|---|
| **Database** | SQLite file (`data/hwpl.db`) — lives on your local machine, not in the repo or on any server |
| **Admin tool** | Local Express server (`tools/admin-server.mjs`) on `127.0.0.1:8787` — weekly data entry, never deployed |
| **Public site** | Fully static — built from a snapshot of the database (`public/data/stats/`) and deployed to GitHub Pages |
| **Hosting** | [GitHub Pages](https://scottjahn.github.io/hwpl-manager/) — free, push-to-deploy via GitHub Actions |

The public site has no live backend. All stats are pre-computed at build time and served as static JSON.

## Features

- Public stats dashboard — player, team, and league tables with drill-down detail pages
- Session summary — per-court match results for a selected date
- Player and team URLs use readable slugs (`/player/alice-nguyen`, `/team/smashers`)
- Local-only admin panel at `/admin` (only accessible during `npm run dev`)
  - Full CRUD for players, teams, leagues, courts, locations, and matches
  - Matches record a location (venue); the location flagged as default is pre-selected
  - Court assignment planner with drag-and-drop
  - DUPR CSV export by date

## Requirements

- Node.js 22+
- macOS (the favicon script uses `sips`; everything else is cross-platform)

## First-time setup

```bash
npm install
```

Then either seed demo data or import from Azure SQL (see below).

## Weekly workflow

1. **Enter this week's data** — start the local dev server and use the admin panel:
   ```bash
   npm run dev
   # open http://localhost:5173/admin
   ```

2. **Export to static JSON** — snapshot the database for the public site:
   ```bash
   npm run export
   ```

3. **Publish** — commit the snapshot and push; the Pages workflow redeploys in a minute or two:
   ```bash
   git add public/data/
   git commit -m "Stats update $(date +%Y-%m-%d)"
   git push
   ```
   Watch the run under the repo's **Actions** tab if you want to confirm it landed.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start Vite dev server (`:5173`) + local admin API (`:8787`) together |
| `npm run dev:web` | Vite only |
| `npm run dev:api` | Admin server only |
| `npm run seed` | Seed the database with demo data (skips if data already exists) |
| `npm run export` | Dump SQLite → `public/data/stats/` for the static build |
| `npm run import` | Import data from Azure SQL exports (see below) |
| `npm run build` | TypeScript check + Vite production build |
| `npm run preview` | Preview the production build locally |

## Importing data from Azure SQL

If migrating from the original Azure SQL database:

1. In the Azure Portal Query Editor, run a plain `SELECT * FROM <table>` for each table and download the result as CSV. Tables: `leagues`, `teams`, `courts`, `team_leagues`, `players`, `matches`, `match_participants`.

2. Save the CSV files into a local folder (e.g. `~/import-data/`).

3. Run the importer:
   ```bash
   npm run import -- --dir ~/import-data
   ```
   Add `--force` to wipe and re-import if the database already has data.

4. Export to the static snapshot:
   ```bash
   npm run export
   ```

## Seeding demo data

```bash
npm run seed   # creates 1 league, 2 courts, 2 teams, 6 players, 3 matches
npm run export
```

## Database

The SQLite database lives at `data/hwpl.db` (gitignored). Schema is in `database/schema.sqlite.sql`.

`tools/db.mjs` applies the schema on every open, plus a small idempotent migration step: it adds
`matches.location_id` to older databases, seeds the club's home venue (WFCU Centre Sports Gym) when
the `locations` table is empty, and assigns the default location to any match that has none.

To back up: copy `data/hwpl.db` somewhere safe. The NAS is a good home for the canonical copy.

## Favicon

To regenerate the favicon from the logo (macOS only):

```bash
node tools/create-favicon.mjs
git add public/favicon.ico && git commit -m "Update favicon"
```

## Deployment — GitHub Pages

The site lives at **https://scottjahn.github.io/hwpl-manager/** and is published by
`.github/workflows/deploy.yml` on every push to `main` (or manually via *Actions → Deploy to
GitHub Pages → Run workflow*). No secrets or environment variables are required — the workflow
authenticates with the repo's built-in Pages token.

One-time repo setting: **Settings → Pages → Build and deployment → Source = GitHub Actions**.

Because it's a project site, everything is served from the `/hwpl-manager/` sub-path:

- `vite.config.ts` sets `base` to `/hwpl-manager/` in production and `/` in dev, so the local
  admin panel still lives at `http://localhost:5173/admin`.
- `src/basePath.ts` provides `withBase()` / `stripBase()`. **Any new in-app link, image, or fetch
  path must go through `withBase()`**, and anything read off `window.location.pathname` through
  `stripBase()` — a bare `/player/…` will 404 in production.
- The build copies `index.html` → `404.html`, which is how GitHub Pages hands deep links like
  `/hwpl-manager/player/alice-nguyen` back to the SPA. Those responses carry a 404 status code
  by design; the page itself renders correctly.

`npm run preview` serves the production build at the same sub-path, so it's a faithful local
check of the deployed site.

## Project structure

```
src/                    React + TypeScript frontend
  App.tsx               Public stats portal
  AdminPage.tsx         Local-only admin panel
  dataSource.ts         Dev → /api proxy, prod → /data/stats/*.json
  main.tsx              Entry point; AdminPage is tree-shaken in prod builds

tools/
  admin-server.mjs      Local Express admin API (ops/*, stats/*, exports/dupr)
  db.mjs                SQLite data layer (better-sqlite3)
  stats.mjs             Pure-JS stat computation (port of the original SQL queries)
  export.mjs            Dump SQLite → public/data/stats/
  seed.mjs              Demo data seeder
  import-from-azure.mjs One-time Azure SQL → SQLite importer
  create-favicon.mjs    Generate public/favicon.ico from the logo (macOS)

database/
  schema.sqlite.sql     SQLite table definitions

public/
  brand/                Logo and brand assets
  data/stats/           Committed static JSON snapshot (what the deployed site reads)
  favicon.ico           Generated from the logo
```
