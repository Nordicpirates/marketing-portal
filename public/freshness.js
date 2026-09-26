// How old is this number: one implementation for every portal page.
// Source dates live in snapshot.json "sources"; see docs/FRESHNESS.md.

(function (root) {
  var DAY = 86400000;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Up to AGING days old is current, past STALE it is called out in red.
  var AGING = 2;
  var STALE = 7;

  var LABELS = {
    shopify: "Shopify",
    meta: "Meta",
    gads: "Google Ads",
    amazon: "Amazon",
    sessions: "Sessions",
    landing_pages: "Landing pages",
    channels: "Channels",
    inventory: "Stock",
    sessions_chart: "Sessions chart",
    tracking: "Tracking status",
    tracking_ids: "ID list",
    status_list: "Action list",
    roas_series: "ROAS series",
    fx: "ECB rate",
    experiments: "Experiments",
    snapshot: "Snapshot",
  };

  var CSS =
    ".fr-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px 18px}" +
    ".fr{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;line-height:1.4;" +
    "padding:3px 9px;border-radius:20px;border:1px solid var(--line,rgba(23,23,23,.09));white-space:nowrap}" +
    ".fr b{font-weight:700}" +
    ".fr-fresh{color:var(--green,#2f8f4e);background:rgba(47,143,78,.10);border-color:rgba(47,143,78,.25)}" +
    ".fr-aging{color:#9a7416;background:rgba(207,154,46,.14);border-color:rgba(207,154,46,.35)}" +
    ".fr-stale{color:#a8512a;background:rgba(201,106,61,.14);border-color:rgba(201,106,61,.45)}" +
    ".fr-unknown{color:var(--muted,#8a8073);background:rgba(23,23,23,.05);font-style:italic}" +
    ".fr-why{font-size:11.5px;color:var(--muted,#8a8073);line-height:1.55;margin:0 0 10px 18px;max-width:640px}" +
    "@media(max-width:680px){.fr-row,.fr-why{margin-left:0}.fr{white-space:normal}}";

  function styleOnce(doc) {
    if (doc.getElementById("portal-freshness-css")) return;
    var el = doc.createElement("style");
    el.id = "portal-freshness-css";
    el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }

  function parseDay(iso) {
    if (typeof iso !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function short(iso) {
    var t = parseDay(iso);
    if (t === null) return String(iso == null ? "" : iso);
    var d = new Date(t);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  }

  /** Whole days between an ISO day and today, or null when the date is not a date. */
  function ageDays(iso, now) {
    var t = parseDay(iso);
    if (t === null) return null;
    var n = now || new Date();
    return Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - t) / DAY);
  }

  function state(iso, now) {
    var age = ageDays(iso, now);
    if (age === null) return "unknown";
    if (age > STALE) return "stale";
    if (age > AGING) return "aging";
    return "fresh";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /** One source, one pill. A source with no usable date says so instead of borrowing the page date. */
  function pill(key, entry, now) {
    var label = LABELS[key] || key;
    var asOf = entry ? entry.as_of : undefined;
    var st = state(asOf, now);
    var age = ageDays(asOf, now);
    var unknown = entry && entry.text ? entry.text : "as of unknown";
    var text = st === "unknown" ? unknown : st === "fresh" ? short(asOf) : short(asOf) + " · " + age + "d old";
    return '<span class="fr fr-' + st + '"><b>' + esc(label) + "</b> " + esc(text) + "</span>";
  }

  /** The pills for one section, plus a line of why for anything stale or unknown. */
  function html(sources, keys, now) {
    var map = sources || {};
    var pills = [];
    var why = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entry = map[key];
      pills.push(pill(key, entry, now));
      var st = state(entry ? entry.as_of : undefined, now);
      if ((st === "stale" || st === "unknown") && entry && entry.note) {
        why.push((LABELS[key] || key) + ": " + entry.note);
      }
    }
    return (
      '<div class="fr-row">' + pills.join("") + "</div>" +
      (why.length ? '<div class="fr-why">' + esc(why.join(" · ")) + "</div>" : "")
    );
  }

  /** Paint the pills into #id. A missing element is a no-op, so a page can drop a section. */
  function render(doc, id, sources, keys, now) {
    var el = doc.getElementById(id);
    if (!el) return false;
    styleOnce(doc);
    el.innerHTML = html(sources, keys, now);
    return true;
  }

  root.Freshness = { render: render, html: html, pill: pill, state: state, ageDays: ageDays, short: short, LABELS: LABELS, AGING: AGING, STALE: STALE };
})(typeof window !== "undefined" ? window : globalThis);
