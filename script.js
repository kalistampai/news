/* DISPATCH — reads the briefing, its dated archives, and the feed health reports
   from a GitHub Gist and renders the board. Read-only: no token in the browser.
   One API call pulls every day at once, so filtering, collapsing, ranking,
   diffing and day-flipping all happen locally with no further requests. */

/* ============================ CONFIG — EDIT GIST_ID ======================== */
const CONFIG = {
  // The Gist API endpoint returns the latest revision of ALL files (latest day
  // + every dated archive + feed reports) and sends CORS headers. Unauthenticated
  // reads are rate-limited to 60/hr per IP, which is what caps auto-refresh below.
  GIST_ID: "368b2174f9c6e7a09df1eae9d814940f",
  LATEST_FILE: "briefing.json",
  LATEST_REPORT: "feedreport.json",

  // Fallback: a raw Gist URL WITHOUT the commit hash (…/raw/briefing.json) always
  // serves the newest content. Leave "" to skip. NOTE: the raw fallback can only
  // return the latest day — archive, health, leaderboard and diff need the API.
  RAW_URL: "",

  // IANA zone for all displayed timestamps. America/Los_Angeles switches between
  // PST and PDT automatically, so the label is always correct.
  TZ: "America/Los_Angeles",

  // Auto-refresh floor. 5 min = 12 req/hr against the unauthenticated 60/hr cap,
  // leaving room for manual reloads. Anything faster risks a 403 lockout.
  MIN_REFRESH_MINUTES: 5,
};
/* ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const board = $("#board");
const BRIEF_RE = /^briefing-(\d{4}-\d{2}-\d{2})\.json$/;
const REPORT_RE = /^feedreport-(\d{4}-\d{2}-\d{2})\.json$/;

let STORE = { dates: [], byDate: {}, reports: {} };   // dates sorted newest-first
let currentIndex = 0;
let QUERY = "";           // active keyword filter, persists across days
let MIN_SCORE = 0;        // score threshold, persists across days
let COLLAPSED = new Set();// category names collapsed by the user
let LB_SORT = "features"; // leaderboard sort key
let LB_ALL_DAYS = false;  // leaderboard scope
let DIFF_AGAINST = null;  // date the diff panel compares to
let refreshTimer = null;

/* ------------------------------ preferences ------------------------------ */
/* This is a real static site (not a sandboxed artifact), so localStorage is
   available and is the right place for view preferences. Every read/write is
   guarded: private-mode Safari and disabled-storage browsers throw on access. */
const PREF_KEY = "dispatch.prefs.v1";

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : {};
  } catch (_) { return {}; }
}

function savePrefs(patch) {
  try {
    const next = { ...loadPrefs(), ...patch };
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch (_) { /* storage unavailable — preferences just won't persist */ }
}

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
      if (r.status === 403) throw new Error(
        "GitHub API rate limit reached (60/hr per IP). Try again shortly, " +
        "or lower the auto-refresh frequency.");
    } catch (e) {
      if (e && /rate limit/i.test(e.message)) throw e;   // surface, don't mask
      /* otherwise fall through to RAW_URL */
    }
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

/* -------------------------- filtering (search + score) -------------------- */
/* Multi-term AND matching. "cve linux" matches items containing BOTH, in any
   field. Purely client-side over the already-loaded day — no extra requests. */
function tokens(q) {
  return String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
}

function cardHaystack(item) {
  return [item.title, item.source, item.reasoning, ...(item.bullets || [])]
    .join(" ").toLowerCase();
}

function notableHaystack(item) {
  return [item.title, item.source].join(" ").toLowerCase();
}

function matchesAll(hay, toks) {
  return toks.every((t) => hay.includes(t));
}

function scoreOf(item) {
  return typeof item.score === "number" ? item.score : 0;
}

/* Returns a briefing-shaped object containing only matching items.

   NOTE ON SCORE + NOTABLE: editor.py writes also_notable as {title, source, url}
   with NO score field, so notable items cannot be score-filtered. Rather than
   silently keep unscored items while the threshold hides scored ones, any
   threshold above 0 hides the notable strip entirely and the UI says so. */
function filterBriefing(data, query, minScore) {
  const toks = tokens(query);
  const cats = data.categories || {};
  const notable = data.also_notable || [];
  const totalFeat = Object.values(cats).reduce((n, v) => n + (v?.length || 0), 0);
  const totalNote = notable.length;
  const active = toks.length > 0 || minScore > 0;

  if (!active) {
    return { data, active: false, scoreActive: false, totalFeat, totalNote,
             matchFeat: totalFeat, matchNote: totalNote };
  }

  const outCats = {};
  let matchFeat = 0;
  for (const [name, items] of Object.entries(cats)) {
    const keep = (items || []).filter((it) =>
      scoreOf(it) >= minScore && (!toks.length || matchesAll(cardHaystack(it), toks)));
    if (keep.length) { outCats[name] = keep; matchFeat += keep.length; }
  }

  const outNote = minScore > 0
    ? []
    : notable.filter((it) => matchesAll(notableHaystack(it), toks));

  return {
    data: { ...data, categories: outCats, also_notable: outNote },
    active: true, scoreActive: minScore > 0, totalFeat, totalNote,
    matchFeat, matchNote: outNote.length,
  };
}

function syncSearchUI(res) {
  const countEl = $("#searchCount");
  const clearEl = $("#searchClear");
  clearEl.hidden = !tokens(QUERY).length;
  countEl.textContent = res.active
    ? `${res.matchFeat}/${res.totalFeat} features · ${res.matchNote}/${res.totalNote} notable`
      + (res.scoreActive ? ` · notable hidden (unscored)` : "")
    : "";
  countEl.dataset.empty = String(res.active && !res.matchFeat && !res.matchNote);
}

function syncScoreUI() {
  $("#scoreRange").value = String(MIN_SCORE);
  $("#scoreValue").textContent = MIN_SCORE === 0 ? "all" : `≥ ${MIN_SCORE}`;
  $("#scoreValue").dataset.on = String(MIN_SCORE > 0);
  $("#scoreReset").hidden = MIN_SCORE === 0;
}

function applyFilter() {
  const dates = STORE.dates;
  if (!dates.length) return;
  const data = STORE.byDate[dates[currentIndex]];
  const res = filterBriefing(data, QUERY, MIN_SCORE);
  render(res.data, res);
  syncSearchUI(res);
  syncScoreUI();
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
  const { dates } = STORE;
  if (i < 0 || i >= dates.length) return;
  currentIndex = i;
  applyFilter();                 // renders the day through the active filters
  renderHealth(dates[i]);
  renderLeaderboard();
  syncDiffUI();
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

function hostOf(u) {
  try { return new URL(u).hostname.replace("www.", ""); } catch (_) { return u; }
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

  const line = (r) =>
    `<code>${escapeHtml(hostOf(r.url))}</code> <span class="arrow">` +
    `${escapeHtml(r.from || "—")} → ${escapeHtml(r.to || "—")}</span>`;

  let deltaHtml = "";
  if (deltas) {
    deltaHtml =
      deltaBlock("Went dark since " + prevDate, "bad", deltas.wentDark, line) +
      deltaBlock("Recovered since " + prevDate, "good", deltas.recovered, line) +
      deltaBlock("Changed failure mode", "warn", deltas.changed, line) +
      deltaBlock("New sources", "info", deltas.added,
                 (r) => `<code>${escapeHtml(hostOf(r.url))}</code> ` +
                        `<span class="arrow">${escapeHtml(r.to)}</span>`) +
      deltaBlock("Removed from feeds.txt", "info", deltas.removed,
                 (r) => `<code>${escapeHtml(hostOf(r.url))}</code>`);
    if (!deltaHtml) {
      deltaHtml = `<p class="delta__none">No status changes since ${escapeHtml(prevDate)}.</p>`;
    }
  } else {
    deltaHtml = `<p class="delta__none">No earlier report to compare against yet — ` +
                `day-over-day changes appear from the second run onward.</p>`;
  }
  $("#healthDeltas").innerHTML = deltaHtml;

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
                  ${escapeHtml(s.source || hostOf(s.url))}</a>
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

/* --------------------------- source leaderboard -------------------------- */
/* Ranks the sources that actually earn their slot in feeds.txt. Feature-tier
   items carry scores; also_notable items do not, so they count toward "notable"
   and "total" but never toward avg/best score. */
function tallySources(dates) {
  const t = new Map();
  const get = (src) => {
    if (!t.has(src)) t.set(src, {
      source: src, features: 0, notable: 0, scoreSum: 0, best: 0, days: new Set(),
    });
    return t.get(src);
  };

  dates.forEach((date) => {
    const day = STORE.byDate[date];
    if (!day) return;
    Object.values(day.categories || {}).forEach((items) => {
      (items || []).forEach((it) => {
        const row = get(it.source || hostOf(it.url || ""));
        row.features += 1;
        row.scoreSum += scoreOf(it);
        row.best = Math.max(row.best, scoreOf(it));
        row.days.add(date);
      });
    });
    (day.also_notable || []).forEach((it) => {
      const row = get(it.source || hostOf(it.url || ""));
      row.notable += 1;
      row.days.add(date);
    });
  });

  return Array.from(t.values()).map((r) => ({
    ...r,
    total: r.features + r.notable,
    avg: r.features ? r.scoreSum / r.features : 0,
    dayCount: r.days.size,
  }));
}

const LB_SORTS = {
  features: (a, b) => b.features - a.features || b.avg - a.avg,
  avg:      (a, b) => b.avg - a.avg || b.features - a.features,
  best:     (a, b) => b.best - a.best || b.features - a.features,
  total:    (a, b) => b.total - a.total || b.features - a.features,
};

function renderLeaderboard() {
  const panel = $("#boardPanel");
  if (!STORE.dates.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const scope = LB_ALL_DAYS ? STORE.dates : [STORE.dates[currentIndex]];
  const rows = tallySources(scope).sort(LB_SORTS[LB_SORT] || LB_SORTS.features);

  $("#boardHeadline").innerHTML =
    `Source leaderboard — <b>${rows.length}</b> source${rows.length === 1 ? "" : "s"}` +
    (LB_ALL_DAYS ? ` across ${scope.length} day${scope.length === 1 ? "" : "s"}` : "");

  const maxFeat = Math.max(1, ...rows.map((r) => r.features));
  $("#lbTable").innerHTML = rows.length ? `
    <div class="lb__head">
      <span>#</span><span>source</span><span>feat</span>
      <span>notable</span><span>avg</span><span>best</span>
    </div>` + rows.map((r, i) => `
    <div class="lb__row" data-top="${i < 3}">
      <span class="lb__rank">${i + 1}</span>
      <span class="lb__src">
        <span class="lb__bar" style="width:${(r.features / maxFeat) * 100}%"></span>
        <span class="lb__name">${escapeHtml(r.source)}</span>
      </span>
      <span class="lb__n">${r.features}</span>
      <span class="lb__n lb__n--dim">${r.notable}</span>
      <span class="lb__n">${r.features ? r.avg.toFixed(1) : "—"}</span>
      <span class="lb__n ${r.best >= 9 ? "is-hot" : ""}">${r.best || "—"}</span>
    </div>`).join("")
    : `<p class="delta__none">Nothing to rank in this briefing.</p>`;

  const zero = rows.filter((r) => !r.features).length;
  $("#lbFoot").textContent =
    (LB_ALL_DAYS ? `All ${scope.length} archived day(s)` : `Day ${scope[0]}`) +
    ` · ${rows.length} sources appeared` +
    (zero ? ` · ${zero} produced notable-only (no feature-tier hits)` : "") +
    ` · sources absent entirely are in the feed health panel above`;
}

/* -------------------------------- diff view ------------------------------ */
/* Compares two briefings by item URL (the stable identity — titles get rewritten
   by the editor, URLs are re-attached from the source record and never change). */
function itemsOf(day) {
  const out = [];
  Object.entries(day.categories || {}).forEach(([cat, items]) => {
    (items || []).forEach((it) => out.push({ ...it, category: cat, tier: "feature" }));
  });
  (day.also_notable || []).forEach((it) =>
    out.push({ ...it, category: "Also notable", tier: "notable" }));
  return out;
}

function keyOf(it) {
  return it.url || ("t:" + String(it.title || "").toLowerCase().replace(/\W+/g, ""));
}

function computeDiff(curDay, prevDay) {
  const cur = new Map(itemsOf(curDay).map((i) => [keyOf(i), i]));
  const prev = new Map(itemsOf(prevDay).map((i) => [keyOf(i), i]));
  const added = [], dropped = [], carried = [], promoted = [];

  for (const [k, it] of cur) {
    if (!prev.has(k)) { added.push(it); continue; }
    const was = prev.get(k);
    if (was.tier !== it.tier) promoted.push({ ...it, from: was.tier, to: it.tier });
    else carried.push(it);
  }
  for (const [k, it] of prev) if (!cur.has(k)) dropped.push(it);

  const srcCur = new Set(itemsOf(curDay).map((i) => i.source));
  const srcPrev = new Set(itemsOf(prevDay).map((i) => i.source));
  const newSources = [...srcCur].filter((s) => !srcPrev.has(s));
  const goneSources = [...srcPrev].filter((s) => !srcCur.has(s));

  return { added, dropped, carried, promoted, newSources, goneSources };
}

function diffList(title, cls, items, opts = {}) {
  if (!items.length) return "";
  const rows = items.slice(0, opts.limit || 40).map((it) => `
    <li>
      <a href="${escapeHtml(it.url || "#")}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(it.title || "Untitled")}</a>
      <span class="diff__meta">${escapeHtml(it.source || "")}${
        typeof it.score === "number" ? ` · ${it.score}/10` : ""}${
        it.from ? ` · ${escapeHtml(it.from)} → ${escapeHtml(it.to)}` : ""}</span>
    </li>`).join("");
  const more = items.length > (opts.limit || 40)
    ? `<li class="diff__more">+ ${items.length - (opts.limit || 40)} more</li>` : "";
  return `<div class="diff__col diff__col--${cls}">
    <h4>${escapeHtml(title)} <span>[${items.length}]</span></h4>
    <ul>${rows}${more}</ul></div>`;
}

function renderDiff() {
  const panel = $("#diffPanel");
  const dates = STORE.dates;
  if (dates.length < 2) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const baseDate = dates[currentIndex];
  const against = DIFF_AGAINST && STORE.byDate[DIFF_AGAINST] && DIFF_AGAINST !== baseDate
    ? DIFF_AGAINST
    : (dates[currentIndex + 1] || dates.find((d) => d !== baseDate));

  $("#diffBase").textContent = baseDate;
  const d = computeDiff(STORE.byDate[baseDate], STORE.byDate[against]);

  $("#diffDot").dataset.level = d.added.length ? "good" : "warn";
  $("#diffHeadline").innerHTML =
    `Diff view — <b>${d.added.length}</b> new, <b>${d.dropped.length}</b> gone, ` +
    `${d.carried.length} carried over`;

  $("#diffGrid").innerHTML =
    diffList(`New in ${baseDate}`, "add", d.added) +
    diffList(`Gone since ${against}`, "drop", d.dropped) +
    diffList("Tier changed", "move", d.promoted) +
    (d.added.length || d.dropped.length || d.promoted.length ? "" :
      `<p class="delta__none">These two briefings contain the same items.</p>`);

  const srcBits = [];
  if (d.newSources.length) srcBits.push(`new sources: ${d.newSources.slice(0, 8).join(", ")}`);
  if (d.goneSources.length) srcBits.push(`absent today: ${d.goneSources.slice(0, 8).join(", ")}`);
  $("#diffFoot").textContent =
    `${baseDate} vs ${against} · matched by article URL` +
    (srcBits.length ? ` · ${srcBits.join(" · ")}` : "");
}

function syncDiffUI() {
  const sel = $("#diffSelect");
  const dates = STORE.dates;
  const baseDate = dates[currentIndex];
  const options = dates.filter((d) => d !== baseDate);
  sel.innerHTML = "";
  options.forEach((d) => {
    const o = document.createElement("option");
    o.value = d; o.textContent = d;
    sel.appendChild(o);
  });
  if (!options.includes(DIFF_AGAINST)) DIFF_AGAINST = options[0] || null;
  if (DIFF_AGAINST) sel.value = DIFF_AGAINST;
  renderDiff();
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
  const collapsed = COLLAPSED.has(name);
  section.dataset.collapsed = String(collapsed);

  const head = document.createElement("button");
  head.className = "category__head";
  head.type = "button";
  head.setAttribute("aria-expanded", String(!collapsed));
  head.innerHTML =
    `<span class="slash">//</span><h2>${escapeHtml(name)}</h2>` +
    `<span class="rule"></span><span class="count">[${items.length}]</span>` +
    `<span class="category__chev" aria-hidden="true">▾</span>`;

  const body = document.createElement("div");
  body.className = "category__body";
  body.hidden = collapsed;
  items.forEach((it) => body.appendChild(renderCard(it)));

  head.addEventListener("click", () => {
    const nowCollapsed = !COLLAPSED.has(name);
    if (nowCollapsed) COLLAPSED.add(name); else COLLAPSED.delete(name);
    section.dataset.collapsed = String(nowCollapsed);
    head.setAttribute("aria-expanded", String(!nowCollapsed));
    body.hidden = nowCollapsed;
    savePrefs({ collapsed: [...COLLAPSED] });
  });

  section.appendChild(head);
  section.appendChild(body);
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

function render(data, filterRes) {
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
    const why = filterRes && filterRes.scoreActive && !tokens(QUERY).length
      ? `No items scored ≥ ${MIN_SCORE}.`
      : filterRes && filterRes.active
        ? `No items match <b>${escapeHtml(QUERY)}</b>${
            filterRes.scoreActive ? ` at score ≥ ${MIN_SCORE}` : ""}.`
        : "No items in this briefing.";
    board.innerHTML = filterRes && filterRes.active
      ? `<div class="state">${why}
           <button class="state__reset" id="stateReset">clear filters</button></div>`
      : `<div class="state">${why}</div>`;
    const reset = $("#stateReset");
    if (reset) reset.addEventListener("click", () => {
      $("#searchInput").value = ""; QUERY = ""; MIN_SCORE = 0;
      savePrefs({ minScore: 0 }); applyFilter();
    });
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
  $("#searchBar").hidden = false;
  $("#controlBar").hidden = false;
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

/* ------------------------------ auto-refresh ------------------------------ */
/* Re-fetches the Gist on an interval and swaps in new data WITHOUT losing your
   place: the current day is tracked by DATE, not index, because a new briefing
   shifts every index by one. If you are pinned to an archived day, the data
   updates silently behind you and a NEW BRIEFING flag appears. */
async function refreshNow({ silent = false } = {}) {
  const stamp = $("#refreshStamp");
  if (!silent) stamp.textContent = "checking…";
  try {
    const gist = await fetchGist();
    const next = await buildStore(gist);
    if (!next.dates.length) throw new Error("Gist returned no briefings.");

    const wasDate = STORE.dates[currentIndex];
    const wasNewest = currentIndex === 0;
    const newestChanged = next.dates[0] !== STORE.dates[0];

    STORE = next;
    const idx = STORE.dates.indexOf(wasDate);
    currentIndex = wasNewest ? 0 : (idx === -1 ? 0 : idx);

    $("#newFlag").hidden = !(newestChanged && !wasNewest);

    applyFilter();
    renderHealth(STORE.dates[currentIndex]);
    renderLeaderboard();
    syncDiffUI();
    syncArchiveUI();

    stamp.textContent = "checked " + fmtPacific(new Date().toISOString(), { withDate: false });
    stamp.dataset.state = "";
  } catch (e) {
    stamp.textContent = (e && e.message) || "refresh failed";
    stamp.dataset.state = "error";
  }
}

function scheduleRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const on = $("#autoRefresh").checked;
  const mins = Math.max(CONFIG.MIN_REFRESH_MINUTES, Number($("#refreshEvery").value) || 15);
  $("#refreshEvery").disabled = !on;
  if (!on) { $("#refreshStamp").textContent = ""; return; }
  refreshTimer = setInterval(() => refreshNow({ silent: true }), mins * 60 * 1000);
  $("#refreshStamp").textContent = `every ${mins}m`;
}

/* --------------------------------- boot ---------------------------------- */
(async function boot() {
  // restore preferences before the first render
  const prefs = loadPrefs();
  MIN_SCORE = Number.isFinite(prefs.minScore) ? Math.min(10, Math.max(0, prefs.minScore)) : 0;
  COLLAPSED = new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed : []);
  LB_SORT = LB_SORTS[prefs.lbSort] ? prefs.lbSort : "features";
  LB_ALL_DAYS = !!prefs.lbAllDays;

  try {
    const gist = await fetchGist();
    STORE = await buildStore(gist);
    if (!STORE.dates.length) throw new Error("No briefing found in the Gist yet.");

    $("#archiveSelect").addEventListener("change",
      (e) => showIndex(Number(e.target.value)));
    $("#prevDay").addEventListener("click", () => showIndex(currentIndex + 1));
    $("#nextDay").addEventListener("click", () => showIndex(currentIndex - 1));
    $("#latestBtn").addEventListener("click", () => {
      $("#newFlag").hidden = true; showIndex(0);
    });

    const input = $("#searchInput");
    input.addEventListener("input", (e) => { QUERY = e.target.value; applyFilter(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { input.value = ""; QUERY = ""; applyFilter(); input.blur(); }
    });
    $("#searchClear").addEventListener("click", () => {
      input.value = ""; QUERY = ""; applyFilter(); input.focus();
    });

    // score threshold
    const range = $("#scoreRange");
    range.value = String(MIN_SCORE);
    range.addEventListener("input", (e) => {
      MIN_SCORE = Number(e.target.value) || 0;
      savePrefs({ minScore: MIN_SCORE });
      applyFilter();
    });
    $("#scoreReset").addEventListener("click", () => {
      MIN_SCORE = 0; savePrefs({ minScore: 0 }); applyFilter();
    });

    // category collapse
    $("#collapseAll").addEventListener("click", () => {
      $$(".category").forEach((s) => {
        const n = $("h2", s)?.textContent; if (n) COLLAPSED.add(n);
      });
      savePrefs({ collapsed: [...COLLAPSED] }); applyFilter();
    });
    $("#expandAll").addEventListener("click", () => {
      COLLAPSED.clear(); savePrefs({ collapsed: [] }); applyFilter();
    });

    // leaderboard controls
    $$("#boardBody [data-sort]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.sort === LB_SORT);
      btn.addEventListener("click", () => {
        LB_SORT = btn.dataset.sort;
        $$("#boardBody [data-sort]").forEach((b) =>
          b.classList.toggle("is-on", b === btn));
        savePrefs({ lbSort: LB_SORT });
        renderLeaderboard();
      });
    });
    const lbAll = $("#lbAllDays");
    lbAll.checked = LB_ALL_DAYS;
    lbAll.addEventListener("change", (e) => {
      LB_ALL_DAYS = e.target.checked;
      savePrefs({ lbAllDays: LB_ALL_DAYS });
      renderLeaderboard();
    });

    // diff controls
    $("#diffSelect").addEventListener("change", (e) => {
      DIFF_AGAINST = e.target.value; renderDiff();
    });

    // auto-refresh
    const auto = $("#autoRefresh"), every = $("#refreshEvery");
    auto.checked = !!prefs.autoRefresh;
    if (prefs.refreshEvery) every.value = String(prefs.refreshEvery);
    auto.addEventListener("change", () => {
      savePrefs({ autoRefresh: auto.checked }); scheduleRefresh();
    });
    every.addEventListener("change", () => {
      savePrefs({ refreshEvery: Number(every.value) }); scheduleRefresh();
    });
    $("#refreshNow").addEventListener("click", () => refreshNow());
    scheduleRefresh();

    // panel toggles
    [["#healthToggle", "#healthBody"], ["#boardToggle", "#boardBody"],
     ["#diffToggle", "#diffBody"]].forEach(([t, b]) => {
      const toggle = $(t), body = $(b);
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!open));
        body.hidden = open;
      });
    });

    // keyboard: "/" focus filter, j/k days, c collapse-all, e expand-all
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "/" && !typing) { e.preventDefault(); input.focus(); return; }
      if (typing) return;
      if (e.key === "j") showIndex(currentIndex + 1);
      else if (e.key === "k") showIndex(currentIndex - 1);
      else if (e.key === "c") $("#collapseAll").click();
      else if (e.key === "e") $("#expandAll").click();
    });

    showIndex(0);
  } catch (e) {
    renderError(e.message);
  }
})();
