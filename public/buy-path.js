// The buy-path test as two pairs, dark and light, drawn from snapshot.buy_path.
// The numbers come from scripts/buy_path.py; docs/DAILY-REFRESH.md.

(function (root) {
  var PAIRS = [
    ["Dark", ["dark_checkout", "dark_cart"]],
    ["Light", ["light_checkout", "light_cart"]],
  ];

  var CSS =
    ".bp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:13px}" +
    ".bp-card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:16px 18px 6px;box-shadow:var(--shadow)}" +
    ".bp-card h3{font-family:'Asul',serif;font-size:17px;margin-bottom:4px}" +
    ".bp-row{padding:12px 0;border-top:1px solid rgba(23,23,23,.06)}" +
    ".bp-name{font-weight:700;font-size:14.5px;display:block}" +
    ".bp-path{font-size:11.5px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}" +
    ".bp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:9px}" +
    ".bp-stat b{font-family:'Asul',serif;font-size:18px;display:block;color:var(--ink)}" +
    ".bp-stat.c b{color:var(--terra)}" +
    ".bp-stat small{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;line-height:1.25;display:block}" +
    ".bp-7d{font-size:12px;color:var(--ink-soft);opacity:.85;margin-top:8px}" +
    ".bp-7d b{font-weight:600}" +
    "@media(max-width:420px){.bp-stats{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:10px}}";

  function styleOnce(doc) {
    if (doc.getElementById("portal-buy-path-css")) return;
    var el = doc.createElement("style");
    el.id = "portal-buy-path-css";
    el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Null is "no visits to divide by", so it prints a hyphen and never a zero.
  function int(n) { return n == null ? "-" : Number(n).toLocaleString("en-US"); }
  function pct(v) { return v == null ? "-" : v.toFixed(2) + "%"; }
  function eur(v) { return v == null ? "-" : "€" + v.toFixed(2); }
  function day(iso) { return root.Freshness ? root.Freshness.short(iso) : iso; }

  function row(a, week) {
    var w = week
      ? '<div class="bp-7d"><b>Last 7 days:</b> ' + int(week.sessions) + " sessions · " + int(week.orders) +
        " orders · " + pct(week.conv_pct) + " · " + eur(week.eur_per_100) + " per 100</div>"
      : "";
    return (
      '<div class="bp-row" data-arm="' + esc(a.arm) + '">' +
      '<b class="bp-name">' + esc(a.name) + '</b><div class="bp-path">' + esc(a.path) + "</div>" +
      '<div class="bp-stats">' +
      '<div class="bp-stat"><b>' + int(a.sessions) + "</b><small>sessions</small></div>" +
      '<div class="bp-stat"><b>' + int(a.orders) + "</b><small>orders</small></div>" +
      '<div class="bp-stat c"><b>' + pct(a.conv_pct) + "</b><small>conversion</small></div>" +
      '<div class="bp-stat"><b>' + eur(a.eur_per_100) + "</b><small>EUR per 100 visitors</small></div>" +
      "</div>" + w + "</div>"
    );
  }

  /** Paint the two cards; false when the snapshot has no buy-path block to draw. */
  function render(doc, block) {
    var test = block && block.windows && block.windows.test;
    if (!test || !(test.arms || []).length) return false;
    styleOnce(doc);
    var week = block.windows["7d"] || null;
    var find = function (w, arm) {
      return w ? (w.arms || []).filter(function (a) { return a.arm === arm; })[0] : null;
    };

    doc.getElementById("bp-caption").textContent =
      "Test window " + day(test.start) + " → " + day(test.end) + ", Shopify orders by the page's tag" +
      (week ? ". Second line: last 7 days, " + day(week.start) + " → " + day(week.end) : "") + ".";

    doc.getElementById("bp-grid").innerHTML = PAIRS.map(function (pair) {
      var rows = pair[1].map(function (arm) {
        var a = find(test, arm);
        return a ? row(a, find(week, arm)) : "";
      }).join("");
      return '<div class="bp-card"><h3>' + pair[0] + "</h3>" + rows + "</div>";
    }).join("");

    var campaign = (test.campaign || []).map(function (c) {
      return esc(c.arm) + " " + int(c.orders) + " orders " + eur(c.revenue_eur);
    });
    doc.getElementById("bp-note").innerHTML =
      esc(block.note || "") +
      (campaign.length ? "<br>Other tagged orders in the test window: " + campaign.join(" · ") + "." : "");
    return true;
  }

  root.BuyPath = { render: render };
})(typeof window !== "undefined" ? window : globalThis);
