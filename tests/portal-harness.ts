// A real portal page in a DOM, driven through its own inline script: the script is
// lifted out, its trailing load() dropped, and both liftings fail loudly when stale.

import { Window } from "happy-dom";
import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");

export const SNAPSHOT = JSON.parse(readFileSync(join(REPO, "data", "snapshot.json"), "utf8"));
export const FRESHNESS_JS = readFileSync(join(REPO, "public", "freshness.js"), "utf8");

export function pageHtml(file: string): string {
  return readFileSync(join(REPO, "public", file), "utf8");
}

/** A page's own script, ready to evaluate, with its self-start call removed. */
export function pageScript(html: string, file: string): string {
  const tag = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!tag) throw new Error(`public/${file} has no inline <script> any more, this harness is stale`);
  const src = tag[1].replace(/\nload\(\);\s*$/, "\n");
  if (src === tag[1]) throw new Error(`public/${file} no longer ends by calling load(), this harness is stale`);
  return src;
}

/** The freshness module's own helpers, so a test never re-implements its date maths. */
export function freshness(): any {
  const w: any = {};
  new Function("window", FRESHNESS_JS)(w);
  if (!w.Freshness) throw new Error("public/freshness.js no longer defines window.Freshness, this harness is stale");
  return w.Freshness;
}

export type PortalPage = {
  window: any;
  document: any;
  /** Everything the page sent to console.error. Expected to stay empty. */
  errors: string[];
  text: (id: string) => string;
  html: (id: string) => string;
  shown: (id: string) => boolean;
  rows: (id: string) => string[][];
  /** Every element the page reserved for a freshness pill. */
  freshnessIds: () => string[];
  /** The charts the page built, in the order it built them. */
  charts: any[];
  el: (id: string) => any;
};

/** Load one portal page with the answers this test wants its fetches to get. */
export async function loadPortalPage(file: string, answers: Record<string, any>): Promise<PortalPage> {
  const html = pageHtml(file);
  const window = new Window({
    url: "https://marketing.nordicpirate.com/",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
    },
  });
  const document = window.document;
  document.write(html);

  const errors: string[] = [];
  const fetchStub = async (path: string) => {
    if (!(path in answers)) throw new Error(`${file} fetched ${path}, which this harness does not answer`);
    return new Response(JSON.stringify(answers[path]), { headers: { "Content-Type": "application/json" } });
  };
  const consoleStub = { ...console, error: (...args: any[]) => void errors.push(args.map(String).join(" ")) };

  // The page loads /freshness.js as a real script tag, which this window does not fetch.
  // Evaluating it against the same window is what the browser would have done.
  new Function("window", FRESHNESS_JS)(window);

  // Chart.js comes from a CDN the browser fetches. The pages only ever construct charts,
  // so a constructor that records nothing is enough to exercise the path they take.
  const charts: any[] = [];
  function Chart(this: any, ctx: any, config: any) {
    charts.push({ ctx, config });
    this.destroy = () => {};
  }

  const start = new Function(
    "window",
    "document",
    "fetch",
    "console",
    "navigator",
    "Chart",
    pageScript(html, file) + "\nreturn load;",
  )(window, document, fetchStub, consoleStub, window.navigator, Chart);
  await start();

  const el = (id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`no #${id} on ${file}`);
    return found;
  };

  return {
    window,
    document,
    errors,
    charts,
    el,
    text: (id: string) => el(id).textContent.replace(/\s+/g, " ").trim(),
    html: (id: string) => el(id).innerHTML,
    shown: (id: string) => el(id).style.display !== "none",
    rows: (id: string) =>
      [...el(id).querySelectorAll("tr")].map((tr: any) =>
        [...tr.querySelectorAll("td")].map((td: any) => td.textContent.trim()),
      ),
    freshnessIds: () => [...document.querySelectorAll('[id^="fr-"]')].map((e: any) => e.id),
  };
}

/** A copy of the snapshot, so a test can change one key without spoiling the next. */
export function snapshotWith(mutate: (copy: any) => void): any {
  const copy = JSON.parse(JSON.stringify(SNAPSHOT));
  mutate(copy);
  return copy;
}
