// qr.nordicpirates.com: a registered slug redirects to its destination and reports the scan
// to the portal; anything else lands on the store. docs/QR-LINKS.md
import REGISTRY from "../../../data/qr-links.json";
import { stockholmDay } from "../../../lib/stockholm-day.js";

export const HIT_URL = "https://marketing.nordicpirate.com/qr/hit";
export const STORE = "https://www.nordicpirates.com/";
const NOT_A_PERSON =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|skype|curl|wget|python|httpclient|okhttp|go-http|headless|lighthouse|monitor|uptime/i;

function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
}

export function deviceOf(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

// A person's GET counts; HEAD, prefetches, link previews and scripts do not.
export function isPersonScan(request) {
  if (request.method !== "GET") return false;
  const purpose = (request.headers.get("sec-purpose") || request.headers.get("purpose") || "").toLowerCase();
  if (purpose.includes("prefetch")) return false;
  const ua = request.headers.get("user-agent") || "";
  return ua !== "" && !NOT_A_PERSON.test(ua);
}

// The same phone on the same day gets the same 16 hex; the day is in the hash, so two days
// cannot be linked, and the IP itself never leaves the edge.
export async function visitorHash(secret, ip, ua, day) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}|${ip}|${ua}|${secret}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function reportScan(request, slug, secret, fetchImpl = fetch) {
  const ua = request.headers.get("user-agent") || "";
  const body = {
    slug,
    country: (request.cf && request.cf.country) || "XX",
    device: deviceOf(ua),
    visitor: await visitorHash(secret, request.headers.get("cf-connecting-ip") || "", ua, stockholmDay(new Date())),
    test: new URL(request.url).searchParams.get("test") === "1",
  };
  const res = await fetchImpl(HIT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-qr-hit-secret": secret },
    body: JSON.stringify(body),
  });
  if (res.status !== 204) console.error(`[qr] the portal answered ${res.status} for slug=${slug}, so this scan was not counted`);
}

export async function onRequest(context) {
  const { request, env } = context;
  const slug = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const link = REGISTRY.links.find((l) => l.slug === slug);
  if (!link) return redirect(STORE);

  const secret = String(env.QR_HIT_SECRET || "").trim();
  if (!secret) {
    console.error("[qr] QR_HIT_SECRET is not set on this Pages project, so no scan is counted");
  } else if (isPersonScan(request)) {
    // The visitor is redirected at once; the count travels after, and a lost count never blocks them.
    context.waitUntil(
      reportScan(request, slug, secret).catch((err) => console.error(`[qr] the scan for slug=${slug} could not be reported:`, err))
    );
  }
  return redirect(link.destination);
}
