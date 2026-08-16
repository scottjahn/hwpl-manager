import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { stripBase, withBase } from "./basePath";
import "./styles.css";

const isAdminRoute = stripBase(window.location.pathname).toLowerCase().startsWith("/admin");

// The admin panel only works against the local admin server (tools/admin-server.mjs).
// In production the static site has no backend — Vite's dead-code elimination removes
// AdminPage from the prod bundle entirely when import.meta.env.DEV is false.
const AdminPage = import.meta.env.DEV
  ? lazy(() => import("./AdminPage"))
  : null;

const AdminNotice = () => (
  <main style={{ padding: "3rem", fontFamily: "system-ui, sans-serif", maxWidth: "40rem", margin: "0 auto" }}>
    <h1>Admin access</h1>
    <p>
      The admin panel is a local-only tool that runs against your SQLite database.
      To make changes, run <code>npm run dev</code> on your machine and open{" "}
      <a href="http://localhost:5173/admin">http://localhost:5173/admin</a>.
    </p>
    <p><a href={withBase("/")}>← Back to league stats</a></p>
  </main>
);

let content: React.ReactNode;
if (isAdminRoute) {
  content = AdminPage
    ? <Suspense fallback={<p style={{ padding: "2rem" }}>Loading…</p>}><AdminPage /></Suspense>
    : <AdminNotice />;
} else {
  content = <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{content}</React.StrictMode>
);
