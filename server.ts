import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { STATE_DIR } from "./lib/state-dir.ts";
import { handleAsset, handleClaim } from "./lib/lp-aboard.ts";
import { handleMarkSent, handleSignups } from "./lib/lp-aboard-admin.ts";
import { addIdea, readBrands, readIdeas } from "./lib/ideas-store.ts";

const AUTH_PASSWORD = (process.env.AUTH_PASSWORD || "pirates2024").trim();
const PORT = parseInt(process.env.PORT || "3000");
const DIR = import.meta.dir;

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

/**
 * One host name, lowercased, with any port and any proxy chain removed, so that two
 * spellings of the same host compare equal.
 *
 * A proxy header can arrive as "marketing.nordicpirate.com:443" or, once a second proxy
 * has appended itself, as "marketing.nordicpirate.com, 10.0.0.5". A browser's Origin has
 * neither of those. Comparing the raw strings refuses the real portal, which is why both
 * sides go through here first.
 *
 * Dropping the port means a different port on the SAME host name counts as ours. That is
 * the deliberate trade: a live deployment terminates TLS in front of this process, so the
 * port seen here is never the port the browser used, and no comparison that keeps it can
 * be right. Different host names, which is what a hostile page actually has, still differ.
 */
function bareHost(value: string): string {
  const first = (value || "").split(",")[0].trim().toLowerCase();
  if (!first) return "";
  // IPv6 keeps its brackets: [::1]:3000 is host [::1], not "[".
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    return end === -1 ? first : first.slice(0, end + 1);
  }
  const colon = first.indexOf(":");
  return colon === -1 ? first : first.slice(0, colon);
}

/** The host= parameter of an RFC 7239 Forwarded header, if there is one. */
function forwardedHost(header: string | null): string {
  if (!header) return "";
  const match = header.split(",")[0].match(/host\s*=\s*"?([^;,"]+)"?/i);
  return match ? bareHost(match[1]) : "";
}

/**
 * Refuse a state-changing request that a browser made on behalf of another site, or
 * that does not say it is sending JSON. Returns null when the request may proceed.
 *
 * What this actually closes. SameSite=Lax keeps the cookie off a cross-SITE request,
 * whether that is a form post or a fetch, so a page on an unrelated domain never had the
 * cookie to begin with. What Lax does not stop is a same-site, cross-ORIGIN request: a
 * page on a sibling subdomain is same-site with this portal, so the cookie rides along.
 * Sending Content-Type: text/plain from there is a "simple" request, so there is no
 * preflight to fail either, and our JSON.parse reads the body happily. Those two checks
 * are what close that gap.
 *
 * Requiring application/json is the half that does not depend on Origin at all: a
 * cross-origin fetch that sets it is no longer "simple", so the browser must preflight,
 * and nothing here answers OPTIONS with CORS headers. Do not add one.
 *
 * Origin is compared by host, through bareHost, against every name this request could
 * legitimately have arrived under. A cross-site page cannot set any of those headers, so
 * this is a browser-only defence and costs a server-to-server caller nothing: no Origin
 * at all is allowed through.
 *
 * Sec-Fetch-Site: same-origin is accepted on its own, because it is the browser stating
 * the conclusion we are trying to reach and it cannot be set by script. It is the way out
 * when a proxy rewrites Host to something internal and sets no forwarding header, where
 * no host comparison here could ever succeed. Only same-origin: same-site is exactly the
 * sibling-subdomain case being refused.
 */
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

/**
 * Run an ideas handler, and turn a store that cannot be used into a short 503.
 *
 * The store throws on purpose rather than reading a file it does not recognise, and an
 * unhandled throw is answered by Bun itself with a page carrying absolute paths, the
 * source lines around the throw and a stack trace. That is tens of kilobytes of internals
 * behind nothing but the staff password. This says one sentence instead, and says it the
 * same way whatever NODE_ENV happens to be, so the answer does not depend on how the
 * container was started. The detail goes to the log, where an operator can read it.
 */
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

// 1 MB. Nothing this server accepts is remotely that big: the largest real body
// is a claim form with an email address in it. Bun's default ceiling is 128 MB,
// which on a public endpoint is a free way to make us hold rubbish in memory.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  // Bun decides this from NODE_ENV, and nothing in this repo sets NODE_ENV, so an
  // unhandled throw anywhere in here would be answered with Bun's development page:
  // absolute paths, the source lines around the throw, and a stack trace. Say it here
  // rather than depending on how the container happened to be started.
  development: false,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok");

    // PUBLIC, and deliberately ahead of the password gate below. /lp/aboard is the
    // gift offer page for people arriving from a retargeting ad. They have no login
    // and never will, so nothing under /lp/ may be sent to /login.
    // Trailing slash included: an ad platform or a person will eventually add one.
    const lpPath = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (lpPath === "/lp/aboard/claim") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleClaim(req);
    }
    // The emailer's two routes. Server to server only: they carry their own shared
    // secret in x-lp-admin-secret and answer 403 without it, so they sit here rather
    // than behind the staff password, which would only ever redirect a script to a
    // login page. They are not in the ASSETS map either, so nothing about them is
    // reachable from the public gift page.
    if (lpPath === "/lp/aboard/signups") return handleSignups(req);
    if (lpPath === "/lp/aboard/signups/mark-sent") return handleMarkSent(req);

    if (lpPath.startsWith("/lp/")) {
      // 404 rather than falling through, so an unknown /lp/ path never bounces a
      // logged-out visitor to the staff login screen. The request goes along so
      // the hero video can be served in byte ranges.
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
          // `null`, `[1,2]`, `"text"` and `7` are all valid JSON, and every one of them
          // used to reach addIdea, where reading .brand off null threw and answered 500.
          // A malformed body is the caller's mistake, so say so with a 400 and write
          // nothing.
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

    if (path === "/ideas") {
      const ideasHtml = join(DIR, "public", "ideas.html");
      if (existsSync(ideasHtml)) {
        return new Response(readFileSync(ideasHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
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

    if (path === "/inventory") {
      const invHtml = join(DIR, "public", "inventory.html");
      if (existsSync(invHtml)) {
        return new Response(readFileSync(invHtml), {
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
