import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { STATE_DIR } from "./lib/state-dir.ts";
import { handleAsset, handleClaim } from "./lib/lp-aboard.ts";
import { handleMarkSent, handleSignups } from "./lib/lp-aboard-admin.ts";
import { addIdea, readBrands, readIdeas } from "./lib/ideas-store.ts";
import {
  NOTION_URL,
  NotionError,
  addShipment,
  isConfigured as shipmentsConfigured,
  listShipments,
  validateInput as validateShipment,
} from "./lib/shipments.ts";

const AUTH_PASSWORD = (process.env.AUTH_PASSWORD || "pirates2024").trim();
const PORT = parseInt(process.env.PORT || "3000");
const DIR = import.meta.dir;

// Markup and data both change on every refresh, and a page cached apart from the script
// it loads is a page running old markup under new code. docs/FRESHNESS.md
const NO_CACHE = "no-cache";

/** One portal page, or null when the file is not there. */
function htmlPage(file: string): Response | null {
  const full = join(DIR, "public", file);
  if (!existsSync(full)) return null;
  return new Response(readFileSync(full), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_CACHE },
  });
}

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

// One host in the single spelling the URL parser gives it, port dropped on purpose.
// Why the parser and not slicing, and why the port goes: docs/CROSS-SITE.md
function bareHost(value: string): string {
  // A proxy chain arrives as "first, second". The first entry is the one the client used.
  const first = (value || "").split(",")[0].trim();
  if (!first) return "";
  try {
    return new URL(`http://${first}`).hostname.toLowerCase();
  } catch {
    // Not a host at all. Never returns something that could accidentally match.
    return "";
  }
}

// The host= of an RFC 7239 Forwarded header, anchored so "xhost=" never counts.
// docs/CROSS-SITE.md
function forwardedHost(header: string | null): string {
  if (!header) return "";
  const match = header.split(",")[0].match(/(?:^|;)\s*host\s*=\s*("[^"]*"|[^;]+)/i);
  if (!match) return "";
  return bareHost(match[1].trim().replace(/^"|"$/g, ""));
}

// Refuse a write a browser sent for another site (403) or that is not JSON (415); null
// lets it through. The JSON half is load bearing, Origin is defence in depth: docs/CROSS-SITE.md
function crossSiteRefusal(req: Request, url: URL): Response | null {
  const jsonRefusal = () => {
    const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      console.warn(`[api] refused a ${req.method} to ${url.pathname}: Content-Type "${type || "(none)"}" is not application/json`);
      return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    return null;
  };

  if (req.headers.get("sec-fetch-site") === "same-origin") return jsonRefusal();

  const origin = req.headers.get("origin");
  if (origin) {
    let from = "";
    try {
      from = bareHost(new URL(origin).host);
    } catch {
      from = "";
    }

    const mine = [
      bareHost(url.host),
      bareHost(req.headers.get("x-forwarded-host") || ""),
      forwardedHost(req.headers.get("forwarded")),
    ].filter(Boolean);

    if (!from || !mine.includes(from)) {
      console.warn(`[api] refused a cross-site ${req.method} to ${url.pathname}: Origin "${origin}" is not ${mine.join(" or ")}`);
      return Response.json({ error: "Cross-site request refused" }, { status: 403 });
    }
  }

  return jsonRefusal();
}

// Run an ideas handler, and turn a store that cannot be used into a one-sentence 503
// rather than Bun's own error page. docs/ERROR-ANSWERS.md
async function ideasResponse(work: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    console.error("[ideas] the store could not be used, so the request was refused:", err);
    return Response.json(
      { error: "The ideas store is unavailable. This has been logged for an operator." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Notion said no or could not be reached: a 502 with Notion's status, never Notion's
// own body, which can echo the request back. docs/ERROR-ANSWERS.md
function notionFailure(verb: string, err: unknown): Response {
  if (err instanceof NotionError) {
    console.warn(`[shipments] ${verb} failed: Notion status ${err.status}`);
    return Response.json(
      { error: err.message, notion_status: err.status, notion_url: NOTION_URL },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
  console.error(`[shipments] ${verb} failed:`, err);
  return Response.json(
    { error: "The shipments could not be read. This has been logged for an operator.", notion_status: -1, notion_url: NOTION_URL },
    { status: 502, headers: { "Cache-Control": "no-store" } }
  );
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
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_CACHE },
  });
}

// 1 MB, far above the largest real body, and far below Bun's 128 MB default.
// docs/ERROR-ANSWERS.md
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  // Never Bun's development error page, whatever NODE_ENV is. docs/ERROR-ANSWERS.md
  development: false,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok");

    // PUBLIC, and deliberately ahead of the password gate below: nothing under /lp/ may
    // be sent to /login. docs/PUBLIC-ROUTES.md
    const lpPath = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (lpPath === "/lp/aboard/claim") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleClaim(req);
    }
    // The emailer's two routes, server to server behind their own x-lp-admin-secret.
    // docs/PUBLIC-ROUTES.md
    if (lpPath === "/lp/aboard/signups") return handleSignups(req);
    if (lpPath === "/lp/aboard/signups/mark-sent") return handleMarkSent(req);

    if (lpPath.startsWith("/lp/")) {
      // 404, never the login screen; the request goes along for byte ranges.
      // docs/PUBLIC-ROUTES.md
      return handleAsset(lpPath, req) || new Response("Not found", { status: 404 });
    }

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

    // The asset directory: media kits, brand books, copy library, creator lists. Plain
    // data, so a new link is an entry in data/assets.json and no code change at all.
    if (path === "/api/assets") {
      const p = join(DIR, "data", "assets.json");
      if (!existsSync(p)) return Response.json({ groups: [] });
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

    // Brands ride along with the ideas so the page can build its tabs from data. A
    // third brand is then an entry in data/ideas.json and no code change at all.
    if (path === "/api/ideas") {
      return ideasResponse(async () => {
        if (req.method === "POST") {
          const refusal = crossSiteRefusal(req, url);
          if (refusal) return refusal;

          const body = await req.json().catch(() => null);
          // Valid JSON that is not an object is the caller's mistake: 400, never a 500.
          // docs/ERROR-ANSWERS.md
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            console.warn(`[ideas] refused a POST: the body is not a JSON object`);
            return Response.json({ error: "body must be a JSON object" }, { status: 400 });
          }

          const result = addIdea(body);
          if (!result.ok) {
            console.warn(`[ideas] refused a POST: ${result.error}`);
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json({ idea: result.idea }, { status: 201 });
        }
        if (req.method !== "GET") {
          return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
        }
        return Response.json(
          { brands: readBrands(), ideas: readIdeas() },
          { headers: { "Cache-Control": "no-cache" } }
        );
      });
    }

    // Creator shipments live in Notion via lib/shipments.ts; a missing key refuses writes
    // with 503 and never throws. docs/ERROR-ANSWERS.md
    if (path === "/api/shipments") {
      if (req.method === "POST") {
        const refusal = crossSiteRefusal(req, url);
        if (refusal) return refusal;
        if (!shipmentsConfigured()) {
          console.warn("[shipments] refused a POST: NOTION_PORTAL_TOKEN is not set");
          return Response.json(
            {
              error: "Logging from the portal is not switched on yet: the Notion key is missing. Log it in Notion instead.",
              notion_url: NOTION_URL,
            },
            { status: 503 }
          );
        }
        const body = await req.json().catch(() => null);
        const checked = validateShipment(body);
        if (!checked.ok) {
          console.warn(`[shipments] refused a POST: ${checked.error}`);
          return Response.json({ error: checked.error }, { status: 400 });
        }
        try {
          const shipment = await addShipment(checked.value);
          console.log(`[shipments] added ${shipment.id}`);
          return Response.json({ shipment }, { status: 201 });
        } catch (err) {
          return notionFailure("POST", err);
        }
      }
      if (req.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
      }
      if (!shipmentsConfigured()) {
        return Response.json(
          { configured: false, notion_url: NOTION_URL, shipments: [] },
          { headers: { "Cache-Control": "no-cache" } }
        );
      }
      try {
        const shipments = await listShipments();
        return Response.json(
          { configured: true, notion_url: NOTION_URL, shipments },
          { headers: { "Cache-Control": "no-cache" } }
        );
      } catch (err) {
        return notionFailure("GET", err);
      }
    }

    // The freshness pills every page draws. One file so two pages cannot disagree
    // about how old a number is: public/freshness.js, docs/FRESHNESS.md.
    if (path === "/freshness.js") {
      const fresh = join(DIR, "public", "freshness.js");
      if (existsSync(fresh)) {
        return new Response(readFileSync(fresh), {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": NO_CACHE },
        });
      }
    }

    if (path === "/shipments") {
      const page = htmlPage("shipments.html");
      if (page) return page;
    }

    if (path === "/ideas") {
      const page = htmlPage("ideas.html");
      if (page) return page;
    }

    if (path === "/growth") {
      const page = htmlPage("growth.html");
      if (page) return page;
    }

    if (path === "/dashboard") {
      const page = htmlPage("dashboard.html");
      if (page) return page;
    }

    if (path === "/inventory") {
      const page = htmlPage("inventory.html");
      if (page) return page;
    }

    if (path === "/assets") {
      const page = htmlPage("assets.html");
      if (page) return page;
    }

    const index = htmlPage("index.html");
    if (index) return index;

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Marketing HQ on :${PORT}`);
