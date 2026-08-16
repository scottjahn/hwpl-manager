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
