/* DISPATCH — reads the briefing, its dated archives, and the feed health reports
   from a GitHub Gist and renders the board. Read-only: no token in the browser.
   A single API call pulls every day at once, so flipping between archived days
   (or opening the health panel) makes no further requests. */

/* ============================ CONFIG — EDIT GIST_ID ======================== */
const CONFIG = {
  // The Gist API endpoint returns the latest revision of ALL files (latest day
  // + every dated archive + feed reports) and sends CORS headers. Unauthenticated
  // reads are rate-limited to 60/hr per IP — one fetch per page load, so fine.
  GIST_ID: "368b2174f9c6e7a09df1eae9d814940f",
  LATEST_FILE: "briefing.json",
  LATEST_REPORT: "feedreport.json",

  // Fallback: a raw Gist URL WITHOUT the commit hash (…/raw/briefing.json) always
  // serves the newest content. Leave "" to skip. NOTE: the raw fallback can only
  // return the latest day — archive navigation and feed health need the API.
  RAW_URL: "",

  // IANA zone for all displayed timestamps. America/Los_Angeles switches between
  // PST and PDT automatically, so the label is always correct.
  TZ: "America/Los_Angeles",
};
/* ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const board = $("#board");
const BRIEF_RE = /^briefing-(\d{4}-\d{2}-\d{2})\.json$/;
const REPORT_RE = /^feedreport-(\d{4}-\d{2}-\d{2})\.json$/;

let STORE = { dates: [], byDate: {}, reports: {} };   // dates sorted newest-first
let currentIndex = 0;

/* ------------------------------- time ------------------------------------ */
/* Source timestamps are UTC ISO-8601 (editor.py writes datetime.now(timezone.utc)).
   Rendered in Pacific with an explicit PST/PDT label, so there is never any
   ambiguity about which offset was in effect on a given day. */
function fmtPacific(iso, { withDate = true } = {}) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const opts = {
    timeZone: CONFIG.TZ,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "short",
  };
  if (withDate) {
    opts.weekday = "short"; opts.month = "short";
    opts.day = "2-digit"; opts.year = "numeric";
  }
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  } catch (_) {
    return d.toUTCString().replace("GMT", "UTC");   // very old browsers
  }
}

function utcTitle(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `source timestamp: ${d.toISOString()} (UTC)`;
}

/* ------------------------------ data loading ----------------------------- */
async function fetchGist() {
  if (CONFIG.GIST_ID && CONFIG.GIST_ID !== "PUT_YOUR_GIST_ID_HERE") {
    try {
      const r = await fetch(`https://api.github.com/gists/${CONFIG.GIST_ID}`, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
      });
      if (r.ok) return r.json();
    } catch (_) { /* fall through to RAW_URL */ }
  }
  if (CONFIG.RAW_URL) {
    const r = await fetch(CONFIG.RAW_URL, { cache: "no-store" });
    if (r.ok) return { __rawOnly: await r.json() };
  }
  throw new Error("Could not reach the Gist. Check GIST_ID / RAW_URL in script.js.");
}

/* The Gist API inlines file content only up to ~1 MB; past that it sets
   truncated:true and content is clipped. Silently skipping those would make a
   day vanish from the archive, so follow raw_url instead. */
async function parseFile(file) {
  if (!file) return null;
  try {
    if (file.truncated && file.raw_url) {
      const r = await fetch(file.raw_url, { cache: "no-store" });
      if (!r.ok) return null;
      return JSON.parse(await r.text());
    }
    return JSON.parse(file.content);
  } catch (_) { return null; }
}

async function buildStore(gist) {
  const byDate = {}, reports = {};

  if (gist.__rawOnly) {                          // fallback path: latest day only
    const d = gist.__rawOnly;
    const key = d.date || "latest";
    byDate[key] = d;
    return { dates: [key], byDate, reports };
  }

  const files = gist.files || {};
  for (const [name, file] of Object.entries(files)) {
    const mb = name.match(BRIEF_RE);
    if (mb) { const d = await parseFile(file); if (d) byDate[mb[1]] = d; continue; }
    const mr = name.match(REPORT_RE);
    if (mr) { const d = await parseFile(file); if (d) reports[mr[1]] = d; }
  }

  const latest = await parseFile(files[CONFIG.LATEST_FILE]);
  if (latest) {
    const key = latest.date || "latest";
    if (!byDate[key]) byDate[key] = latest;
  }
  const latestReport = await parseFile(files[CONFIG.LATEST_REPORT]);
  if (latestReport) {
    const key = latestReport.date || "latest";
    if (!reports[key]) reports[key] = latestReport;
  }

  const dates = Object.keys(byDate).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return { dates, byDate, reports };
}

/* --------------------------- archive navigator --------------------------- */
function syncArchiveUI() {
  const { dates } = STORE;
  const sel = $("#archiveSelect");

  // One day of data = nothing to navigate between. dispatch.py writes
  // briefing.json AND briefing-<date>.json from the same payload, so a first run
  // produces two FILES but only one DAY. The bar appears on day two.
  $("#archiveBar").hidden = dates.length <= 1;
  $("#archiveCount").textContent =
    dates.length ? `${dates.length} day${dates.length === 1 ? "" : "s"} archived` : "";

  sel.innerHTML = "";
  dates.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = i === 0 ? `${d}  ·  latest` : d;
    sel.appendChild(opt);
  });
  sel.value = String(currentIndex);

  $("#prevDay").disabled = currentIndex >= dates.length - 1;   // older
  $("#nextDay").disabled = currentIndex <= 0;                  // newer
  $("#latestBtn").disabled = currentIndex === 0;
  $("#archiveFlag").hidden = currentIndex === 0;
}

function showIndex(i) {
  const { dates, byDate } = STORE;
  if (i < 0 || i >= dates.length) return;
  currentIndex = i;
  render(byDate[dates[i]]);
  renderHealth(dates[i]);
  syncArchiveUI();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------ feed health ------------------------------ */
const STATUS_HELP = {
  OK: "Contributing articles",
  STALE: "Reachable, but nothing new in the lookback window",
  FILTERED: "Fresh items existed but all were pre-filtered out",
  EMPTY: "Feed parsed but contains zero entries",
  NO_FEED: "No RSS/Atom feed discoverable at this URL",
  HTTP_404: "Dead URL (404/410) — moved or removed",
  HTTP_403: "Blocked (403) — WAF, bot protection, or UA ban",
  CAPTCHA: "CAPTCHA / JS interstitial instead of content",
  PAYWALL: "Paywalled or requires authentication",
  HTTP_429: "Rate limited by the source",
  HTTP_5XX: "Source server error",
  HTTP_OTHER: "Unexpected HTTP status",
  TIMEOUT: "No response within the timeout",
  DNS_ERROR: "Hostname did not resolve",
  SSL_ERROR: "TLS / certificate failure",
  CONN_ERROR: "Connection failed or was reset",
  PARSE_ERROR: "Response was not parseable RSS/Atom",
};
const SEVERE = new Set(["HTTP_404", "DNS_ERROR", "SSL_ERROR", "NO_FEED",
                        "PARSE_ERROR", "CAPTCHA", "PAYWALL", "HTTP_403"]);

function previousDateWithReport(date) {
  const all = Object.keys(STORE.reports).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const i = all.indexOf(date);
  return i === -1 ? null : (all[i + 1] || null);
}

function computeDeltas(cur, prev) {
  if (!cur || !prev) return null;
  const p = new Map((prev.sources || []).map((s) => [s.url, s.status]));
  const c = new Map((cur.sources || []).map((s) => [s.url, s.status]));
  const wentDark = [], recovered = [], changed = [], added = [], removed = [];
  for (const [url, st] of c) {
    if (!p.has(url)) { added.push({ url, to: st }); continue; }
    const was = p.get(url);
    if (was === st) continue;
    if (was === "OK") wentDark.push({ url, from: was, to: st });
    else if (st === "OK") recovered.push({ url, from: was, to: st });
    else changed.push({ url, from: was, to: st });
  }
  for (const url of p.keys()) if (!c.has(url)) removed.push({ url });
  return { wentDark, recovered, changed, added, removed };
}

function deltaBlock(title, cls, rows, fmt) {
  if (!rows.length) return "";
  return `<div class="delta delta--${cls}">` +
    `<h4>${escapeHtml(title)} <span>[${rows.length}]</span></h4><ul>` +
    rows.map((r) => `<li>${fmt(r)}</li>`).join("") + "</ul></div>";
}

function renderHealth(date) {
  const panel = $("#healthPanel");
  const report = STORE.reports[date];
  if (!report) { panel.hidden = true; return; }
  panel.hidden = false;

  const sources = report.sources || [];
  const ok = sources.filter((s) => s.status === "OK").length;
  const down = sources.length - ok;
  const severe = sources.filter((s) => SEVERE.has(s.status)).length;

  $("#healthDot").dataset.level = severe ? "bad" : down ? "warn" : "good";
  $("#healthHeadline").innerHTML =
    `Feed health — <b>${ok}</b>/${sources.length} contributing` +
    (down ? `, <b class="down">${down}</b> not` : "");

  const prevDate = previousDateWithReport(date);
  const deltas = computeDeltas(report, STORE.reports[prevDate]);
  const tag = $("#healthDeltaTag");
  if (deltas && (deltas.wentDark.length || deltas.recovered.length)) {
    tag.hidden = false;
    tag.textContent =
      (deltas.wentDark.length ? `▼ ${deltas.wentDark.length} went dark` : "") +
      (deltas.wentDark.length && deltas.recovered.length ? " · " : "") +
      (deltas.recovered.length ? `▲ ${deltas.recovered.length} recovered` : "");
    tag.dataset.level = deltas.wentDark.length ? "bad" : "good";
  } else {
    tag.hidden = true;
  }

  // day-over-day changes
  const host = (u) => { try { return new URL(u).hostname.replace("www.", ""); }
                        catch (_) { return u; } };
  const line = (r) =>
    `<code>${escapeHtml(host(r.url))}</code> <span class="arrow">` +
    `${escapeHtml(r.from || "—")} → ${escapeHtml(r.to || "—")}</span>`;

  let deltaHtml = "";
  if (deltas) {
    deltaHtml =
      deltaBlock("Went dark since " + prevDate, "bad", deltas.wentDark, line) +
      deltaBlock("Recovered since " + prevDate, "good", deltas.recovered, line) +
      deltaBlock("Changed failure mode", "warn", deltas.changed, line) +
      deltaBlock("New sources", "info", deltas.added,
                 (r) => `<code>${escapeHtml(host(r.url))}</code> ` +
                        `<span class="arrow">${escapeHtml(r.to)}</span>`) +
      deltaBlock("Removed from feeds.txt", "info", deltas.removed,
                 (r) => `<code>${escapeHtml(host(r.url))}</code>`);
    if (!deltaHtml) {
      deltaHtml = `<p class="delta__none">No status changes since ${escapeHtml(prevDate)}.</p>`;
    }
  } else {
    deltaHtml = `<p class="delta__none">No earlier report to compare against yet — ` +
                `day-over-day changes appear from the second run onward.</p>`;
  }
  $("#healthDeltas").innerHTML = deltaHtml;

  // grouped current failures
  const groups = {};
  sources.filter((s) => s.status !== "OK")
         .forEach((s) => { (groups[s.status] ||= []).push(s); });
  const order = Object.keys(groups).sort(
    (a, b) => (SEVERE.has(b) - SEVERE.has(a)) || groups[b].length - groups[a].length);

  $("#healthGroups").innerHTML = order.length
    ? order.map((st) => `
        <div class="hgroup" data-severe="${SEVERE.has(st)}">
          <div class="hgroup__head">
            <span class="hgroup__code">${escapeHtml(st)}</span>
            <span class="hgroup__n">[${groups[st].length}]</span>
            <span class="hgroup__help">${escapeHtml(STATUS_HELP[st] || "")}</span>
          </div>
          <ul class="hgroup__list">
            ${groups[st].map((s) => `<li>
                <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(s.source || host(s.url))}</a>
                ${s.detail ? `<span class="hgroup__detail">${escapeHtml(s.detail)}</span>` : ""}
              </li>`).join("")}
          </ul>
        </div>`).join("")
    : `<p class="delta__none">Every source is contributing. Nothing to fix.</p>`;

  const gen = report.generated_at ? fmtPacific(report.generated_at) : "";
  $("#healthFoot").textContent =
    `${sources.length} sources checked` +
    (report.lookback_hours ? ` · ${report.lookback_hours}h lookback` : "") +
    (gen ? ` · checked ${gen}` : "") +
    ` · run "python feedcheck.py --failures" locally for a live re-test`;
}

/* ------------------------------- rendering ------------------------------- */
function buildMeter(score) {
  // 0–10 score -> 5-segment meter; top segment turns red at 9+.
  const frag = document.createDocumentFragment();
  const lit = Math.round((Math.max(0, Math.min(10, score)) / 10) * 5);
  for (let i = 1; i <= 5; i++) {
    const seg = document.createElement("i");
    if (i <= lit) seg.classList.add(score >= 9 && i === 5 ? "hot" : "on");
    frag.appendChild(seg);
  }
  return frag;
}

function renderCard(item) {
  const node = $("#cardTpl").content.cloneNode(true);
  const score = typeof item.score === "number" ? item.score : 8;

  $(".meter", node).appendChild(buildMeter(score));
  $(".meter", node).title = `relevance ${score}/10`;
  $(".card__src", node).textContent = item.source || "";
  const scoreEl = $(".card__score", node);
  scoreEl.textContent = `${score}/10`;
  if (score >= 9) scoreEl.classList.add("hot");

  const titleLink = $(".card__title a", node);
  titleLink.textContent = item.title || "Untitled";
  titleLink.href = item.url || "#";

  $(".card__why", node).textContent = item.reasoning || "";

  const ul = $(".card__bullets", node);
  (item.bullets || []).forEach((b) => {
    const li = document.createElement("li");
    li.textContent = b;
    ul.appendChild(li);
  });

  $(".card__link", node).href = item.url || "#";
  return node;
}

function renderCategory(name, items) {
  const section = document.createElement("section");
  section.className = "category";
  const head = document.createElement("div");
  head.className = "category__head";
  head.innerHTML =
    `<span class="slash">//</span><h2>${escapeHtml(name)}</h2>` +
    `<span class="rule"></span><span class="count">[${items.length}]</span>`;
  section.appendChild(head);
  items.forEach((it) => section.appendChild(renderCard(it)));
  return section;
}

function renderNotable(items) {
  const wrap = document.createElement("section");
  wrap.className = "notable";
  wrap.innerHTML = `<h3 class="notable__head">// Also notable</h3>`;
  const list = document.createElement("div");
  list.className = "notable__list";
  items.forEach((it) => {
    const a = document.createElement("a");
    a.className = "notable__item";
    a.href = it.url || "#";
    a.target = "_blank"; a.rel = "noopener noreferrer";
    a.innerHTML =
      `<span class="notable__src">${escapeHtml(it.source || "")}</span>` +
      `<span class="notable__ttl">${escapeHtml(it.title || "")}</span>`;
    list.appendChild(a);
  });
  wrap.appendChild(list);
  return wrap;
}

function render(data) {
  board.innerHTML = "";
  const cats = data.categories || {};
  const catNames = Object.keys(cats).filter((k) => cats[k]?.length);
  let featTotal = 0;

  catNames.forEach((name) => {
    featTotal += cats[name].length;
    board.appendChild(renderCategory(name, cats[name]));
  });

  const notable = data.also_notable || [];
  if (notable.length) board.appendChild(renderNotable(notable));

  if (!catNames.length && !notable.length) {
    board.innerHTML = `<div class="state">No items in this briefing.</div>`;
  }

  // header meta
  const tag = $("#statusTag");
  tag.textContent = "LIVE"; tag.dataset.state = "live";
  $("#dateStamp").textContent = data.date || "";
  $("#featCount").textContent = featTotal;
  $("#notableCount").textContent = notable.length;
  $("#catCount").textContent = catNames.length;

  const gen = $("#genStamp");
  if (data.generated_at) {
    gen.textContent = "compiled " + fmtPacific(data.generated_at);
    gen.title = utcTitle(data.generated_at);
  } else {
    gen.textContent = ""; gen.title = "";
  }
  $("#statBar").hidden = false;
}

function renderError(msg) {
  const tag = $("#statusTag");
  tag.textContent = "OFFLINE"; tag.dataset.state = "error";
  board.innerHTML =
    `<div class="state state--error"><p>${escapeHtml(msg)}</p></div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------- boot ---------------------------------- */
(async function boot() {
  try {
    const gist = await fetchGist();
    STORE = await buildStore(gist);
    if (!STORE.dates.length) throw new Error("No briefing found in the Gist yet.");

    $("#archiveSelect").addEventListener("change",
      (e) => showIndex(Number(e.target.value)));
    $("#prevDay").addEventListener("click", () => showIndex(currentIndex + 1));
    $("#nextDay").addEventListener("click", () => showIndex(currentIndex - 1));
    $("#latestBtn").addEventListener("click", () => showIndex(0));

    const toggle = $("#healthToggle"), body = $("#healthBody");
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
    });

    showIndex(0);
  } catch (e) {
    renderError(e.message);
  }
})();
