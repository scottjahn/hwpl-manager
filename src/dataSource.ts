// Where the app reads league data from:
//  - dev:  the local admin server (Vite proxies /api → http://localhost:8787).
//  - prod: the static snapshot exported to /data/stats/** at build time, served
//          under the deploy base (see basePath.ts).
import { withBase } from "./basePath";

const DEV = import.meta.env.DEV;

export const statsUrl = (name: string): string =>
  DEV ? `/api/stats/${name}` : withBase(`/data/stats/${name}.json`);

export const sessionUrl = (date: string): string =>
  DEV
    ? `/api/stats/session?date=${encodeURIComponent(date)}`
    : withBase(`/data/stats/session/${encodeURIComponent(date)}.json`);

/**
 * Fetch one stats file, always revalidating first.
 *
 * GitHub Pages serves everything with `cache-control: max-age=600`, and that
 * is not configurable. The JS and CSS bundles do not care — their filenames
 * carry a content hash, so a new build is a new URL. These do: publishing new
 * stats rewrites players.json *in place*, so a browser that has visited in the
 * last ten minutes will keep showing the old standings without so much as
 * asking the server. session-dates.json is the worst of it — a newly published
 * session date is missing from the picker entirely until the cache expires.
 *
 * "no-cache" means revalidate before using the cached copy — not "don't
 * cache". Pages sends an ETag, so an unchanged file still comes back as an
 * empty 304 and costs nothing.
 */
export const fetchStats = (url: string): Promise<Response> =>
  fetch(url, { cache: "no-cache" });
