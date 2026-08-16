// The site is served from "/" in dev and from "/hwpl-manager/" on GitHub Pages
// (see vite.config.ts). Vite exposes that prefix as import.meta.env.BASE_URL,
// so every in-app URL is built with withBase() and every URL read back off
// window.location is normalised with stripBase().

// "" in dev, "/hwpl-manager" in the Pages build — no trailing slash either way.
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** Prefix an app-absolute path ("/player/alice") with the deploy base. */
export const withBase = (path: string): string => `${BASE}${path}`;

/** Strip the deploy base off a window.location.pathname, yielding "/player/alice". */
export const stripBase = (pathname: string): string => {
  if (BASE && pathname.toLowerCase().startsWith(BASE.toLowerCase())) {
    return pathname.slice(BASE.length) || "/";
  }
  return pathname;
};
