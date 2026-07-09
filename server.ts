import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const AUTH_PASSWORD = (process.env.AUTH_PASSWORD || "pirates2024").trim();
const PORT = parseInt(process.env.PORT || "3000");
const DIR = import.meta.dir;

// Persistent state dir (volume-mounted in prod) for mutable checklist state.
const STATE_DIR = process.env.STATE_DIR || join(DIR, "state");
try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
const TASKS_FILE = join(STATE_DIR, "tasks.json");
const TASKS_SEED = join(DIR, "data", "tasks.json");

function readTasks(): any {
  // Seed from committed default on first run; merge new seed tasks on later deploys.
  let seed: any = { agency_tasks: [] };
  if (existsSync(TASKS_SEED)) { try { seed = JSON.parse(readFileSync(TASKS_SEED, "utf8")); } catch {} }
  if (!existsSync(TASKS_FILE)) { try { writeFileSync(TASKS_FILE, JSON.stringify(seed, null, 2)); } catch {} return seed; }
  let cur: any = { agency_tasks: [] };
  try { cur = JSON.parse(readFileSync(TASKS_FILE, "utf8")); } catch {}
  // Merge: keep done-state for existing ids, add any new seed tasks.
  const doneMap = new Map((cur.agency_tasks || []).map((t: any) => [t.id, t.done]));
  const merged = (seed.agency_tasks || []).map((t: any) => ({ ...t, done: doneMap.get(t.id) ?? t.done ?? false }));
  const out = { ...seed, agency_tasks: merged };
  try { writeFileSync(TASKS_FILE, JSON.stringify(out, null, 2)); } catch {}
  return out;
}

function setTask(id: string, done: boolean): any {
  const t = readTasks();
  const task = (t.agency_tasks || []).find((x: any) => x.id === id);
  if (task) task.done = done;
  try { writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2)); } catch {}
  return t;
}

// Stateless auth token: hash of the password. Survives restarts/redeploys,
// no in-memory session state to lose.
const AUTH_TOKEN = createHash("sha256").update("np-hq-" + AUTH_PASSWORD).digest("hex");

function checkAuth(req: Request): boolean {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/auth=([a-f0-9]{64})/);
  return match ? match[1] === AUTH_TOKEN : false;
}

function serveLogin(error = false): Response {
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Marketing HQ · Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Asul:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:radial-gradient(900px 460px at 88% -8%,rgba(201,106,61,.10),transparent 60%),radial-gradient(760px 420px at -6% 4%,rgba(207,154,46,.12),transparent 58%),#f2ede4;font-family:'Inter',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#fffdf8;border:1px solid rgba(23,23,23,.09);border-radius:20px;padding:48px 40px;width:100%;max-width:400px;box-shadow:0 1px 2px rgba(23,23,23,.04),0 8px 24px rgba(23,23,23,.08)}
    .logo-wrap{display:flex;align-items:center;gap:12px;margin-bottom:32px}
    .logo-chip{background:#171717;border-radius:13px;padding:11px 13px;display:flex;align-items:center}
    .logo-chip img{height:26px;display:block}
    .logo-text{font-family:'Asul',serif;font-size:14px;font-weight:700;color:#171717;line-height:1.3}
    h1{font-family:'Asul',serif;font-size:24px;color:#171717;margin-bottom:8px}
    p{color:#8a8073;font-size:14px;margin-bottom:28px}
    label{display:block;font-size:13px;font-weight:500;color:#171717;margin-bottom:6px}
    input[type=password]{width:100%;padding:12px 16px;border:1.5px solid rgba(23,23,23,.12);border-radius:10px;font-size:15px;font-family:'Inter',sans-serif;background:#faf9f5;outline:none;transition:border-color .15s;color:#171717}
    input[type=password]:focus{border-color:#c96a3d}
    .error{background:rgba(201,106,61,.10);border:1px solid rgba(201,106,61,.3);border-radius:8px;padding:10px 14px;font-size:13px;color:#a8512a;margin-bottom:16px}
    button{width:100%;padding:14px;background:#171717;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;margin-top:16px;transition:background .15s}
    button:hover{background:#333}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-wrap">
      <div class="logo-chip">
        <img src="https://www.nordicpirates.com/cdn/shop/files/LP_LOGO_vit_e2ed4c01-c782-4abb-8a90-b5cab974fd0a.png?width=120" alt="LP">
      </div>
      <div class="logo-text">Nordic Pirates<br>Marketing HQ</div>
    </div>
    <h1>Välkommen</h1>
    <p>Logga in för att se performance-data, tracking-status och annonsstrategi.</p>
    ${error ? '<div class="error">Fel lösenord — försök igen.</div>' : ""}
    <form method="POST" action="/login">
      <label for="pw">Lösenord</label>
      <input type="password" name="password" id="pw" placeholder="••••••••" autofocus autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
      <button type="submit">Logga in →</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok");

    if (path === "/login") {
      if (req.method === "POST") {
        const form = await req.formData();
        // Trim whitespace and ignore case so phone/Mac autocaps can't lock people out.
        const pw = (form.get("password")?.toString() || "").trim();
        if (pw.toLowerCase() === AUTH_PASSWORD.toLowerCase()) {
          return new Response("", {
            status: 302,
            headers: {
              Location: "/",
              "Set-Cookie": `auth=${AUTH_TOKEN}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`,
            },
          });
        }
        return serveLogin(true);
      }
      return serveLogin(false);
    }

    if (!checkAuth(req)) {
      if (path.startsWith("/api/")) return Response.json({ error: "Unauthorized" }, { status: 401 });
      return new Response("", { status: 302, headers: { Location: "/login" } });
    }

    if (path === "/logout") {
      return new Response("", {
        status: 302,
        headers: { Location: "/login", "Set-Cookie": "auth=; Max-Age=0; Path=/" },
      });
    }

    if (path === "/api/data") {
      const p = join(DIR, "data", "snapshot.json");
      if (!existsSync(p)) return Response.json({ error: "no data" }, { status: 404 });
      return new Response(readFileSync(p), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      });
    }

    if (path === "/api/experiments") {
      const p = join(DIR, "data", "experiments.json");
      if (!existsSync(p)) return Response.json({ experiments: [] });
      return new Response(readFileSync(p), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      });
    }

    if (path === "/api/tasks") {
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (!body.id || typeof body.done !== "boolean")
          return Response.json({ error: "need id + done" }, { status: 400 });
        return Response.json(setTask(body.id, body.done));
      }
      return Response.json(readTasks(), { headers: { "Cache-Control": "no-cache" } });
    }

    if (path === "/growth") {
      const growthHtml = join(DIR, "public", "growth.html");
      if (existsSync(growthHtml)) {
        return new Response(readFileSync(growthHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    if (path === "/dashboard") {
      const dashHtml = join(DIR, "public", "dashboard.html");
      if (existsSync(dashHtml)) {
        return new Response(readFileSync(dashHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    const html = join(DIR, "public", "index.html");
    if (existsSync(html)) {
      return new Response(readFileSync(html), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Marketing HQ on :${PORT}`);
