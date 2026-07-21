/* DISPATCH — reads the briefing (and its dated archives) from a GitHub Gist and
   renders the board. Read-only: no token in the browser. A single API call pulls
   every day at once, so flipping between archived days makes no further requests. */

/* ============================ CONFIG — EDIT GIST_ID ======================== */
const CONFIG = {
  // The Gist API endpoint returns the latest revision of ALL files (latest day
  // + every dated archive) and sends CORS headers. Unauthenticated reads are
  // rate-limited to 60/hr per IP — one fetch per page load, so fine.
  GIST_ID: "368b2174f9c6e7a09df1eae9d814940f",
  LATEST_FILE: "briefing.json",

  // Fallback: a raw Gist URL WITHOUT the commit hash (…/raw/briefing.json) always
  // serves the newest content. Leave "" to skip. NOTE: the raw fallback can only
  // return the latest day — the archive navigator needs the API endpoint above.
  RAW_URL: "",
};
/* ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const board = $("#board");
const ARCHIVE_RE = /^briefing-(\d{4}-\d{2}-\d{2})\.json$/;

let STORE = { dates: [], byDate: {} };   // dates sorted newest-first
let currentIndex = 0;

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

function parseFile(file) {
  try {
    if (!file || file.truncated) return null;   // briefings are small; skip oversized
    return JSON.parse(file.content);
  } catch (_) { return null; }
}

function buildStore(gist) {
  const byDate = {};

  if (gist.__rawOnly) {                          // fallback path: latest day only
    const d = gist.__rawOnly;
    byDate[d.date || "latest"] = d;
    return { dates: [d.date || "latest"], byDate };
  }

  const files = gist.files || {};
  for (const [name, file] of Object.entries(files)) {   // dated archive files
    const m = name.match(ARCHIVE_RE);
    if (!m) continue;
    const data = parseFile(file);
    if (data) byDate[m[1]] = data;
  }
  const latest = parseFile(files[CONFIG.LATEST_FILE]);   // ensure newest is present
  if (latest) {
    const key = latest.date || "latest";
    if (!byDate[key]) byDate[key] = latest;
  }

  const dates = Object.keys(byDate).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return { dates, byDate };
}

/* --------------------------- archive navigator --------------------------- */
function syncArchiveUI() {
  const { dates } = STORE;
  const sel = $("#archiveSelect");

  $("#archiveBar").hidden = dates.length <= 1;   // one day -> no navigator

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
  syncArchiveUI();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  if (data.generated_at) {
    $("#genStamp").textContent =
      "compiled " + new Date(data.generated_at).toUTCString().replace("GMT", "UTC");
  } else {
    $("#genStamp").textContent = "";
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
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------- boot ---------------------------------- */
(async function boot() {
  try {
    const gist = await fetchGist();
    STORE = buildStore(gist);
    if (!STORE.dates.length) throw new Error("No briefing found in the Gist yet.");

    $("#archiveSelect").addEventListener("change", (e) => showIndex(Number(e.target.value)));
    $("#prevDay").addEventListener("click", () => showIndex(currentIndex + 1));
    $("#nextDay").addEventListener("click", () => showIndex(currentIndex - 1));
    $("#latestBtn").addEventListener("click", () => showIndex(0));

    showIndex(0);
  } catch (e) {
    renderError(e.message);
  }
})();
