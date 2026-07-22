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

let STORE = { dates: [], byDate: {} };   // dates sorted newest-first
let currentIndex = 0;
let currentData = null;                  // holds the active day's raw data for filtering

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
  for (const [name, file] of Object.entries(files)) {
    if (!name.endsWith(".json")) continue;       // scan all json files safely
    const data = parseFile(file);
    if (!data) continue;

    // Use internal date property first, otherwise extract YYYY-MM-DD from filename
    const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
    const key = data.date || (dateMatch ? dateMatch[1] : (name === CONFIG.LATEST_FILE ? "latest" : null));
    if (key) {
      byDate[key] = data;
    }
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
  currentData = byDate[dates[i]];
  
  // Clear any active search query when changing dates
  if ($("#searchInput")) $("#searchInput").value = "";
  
  render(currentData);
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

function highlightText(text, query) {
  const safeText = escapeHtml(text || "");
  if (!query) return safeText;
  const escapedQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQ})`, "gi");
  return safeText.replace(regex, '<mark class="highlight">$1</mark>');
}

function renderCard(item, query = "") {
  const node = $("#cardTpl").content.cloneNode(true);
  const score = typeof item.score === "number" ? item.score : 8;

  $(".meter", node).appendChild(buildMeter(score));
  $(".card__src", node).innerHTML = highlightText(item.source || "", query);
  const scoreEl = $(".card__score", node);
  scoreEl.textContent = `${score}/10`;
  if (score >= 9) scoreEl.classList.add("hot");

  const titleLink = $(".card__title a", node);
  titleLink.innerHTML = highlightText(item.title || "Untitled", query);
  titleLink.href = item.url || "#";

  $(".card__why", node).innerHTML = highlightText(item.reasoning || "", query);

  const ul = $(".card__bullets", node);
  (item.bullets || []).forEach((b) => {
    const li = document.createElement("li");
    li.innerHTML = highlightText(b, query);
    ul.appendChild(li);
  });

  $(".card__link", node).href = item.url || "#";
  return node;
}

function renderCategory(name, items, query = "") {
  const section = document.createElement("section");
  section.className = "category";
  const head = document.createElement("div");
  head.className = "category__head";
  head.innerHTML =
    `<span class="slash">//</span><h2>${escapeHtml(name)}</h2>` +
    `<span class="rule"></span><span class="count">[${items.length}]</span>`;
  section.appendChild(head);
  items.forEach((it) => section.appendChild(renderCard(it, query)));
  return section;
}

function renderNotable(items, query = "") {
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
      `<span class="notable__src">${highlightText(it.source || "", query)}</span>` +
      `<span class="notable__ttl">${highlightText(it.title || "", query)}</span>`;
    list.appendChild(a);
  });
  wrap.appendChild(list);
  return wrap;
}

function render(data, query = "") {
  board.innerHTML = "";
  const q = query.trim().toLowerCase();
  
  // Filter categories by search keyword
  const origCats = data.categories || {};
  const filteredCats = {};
  let featTotal = 0;

  Object.keys(origCats).forEach((name) => {
    const items = origCats[name].filter((it) => {
      if (!q) return true;
      const inTitle = (it.title || "").toLowerCase().includes(q);
      const inSrc = (it.source || "").toLowerCase().includes(q);
      const inWhy = (it.reasoning || "").toLowerCase().includes(q);
      const inBullets = (it.bullets || []).some((b) => String(b).toLowerCase().includes(q));
      return inTitle || inSrc || inWhy || inBullets;
    });
    if (items.length) {
      filteredCats[name] = items;
      featTotal += items.length;
    }
  });

  // Filter notable items by search keyword
  const origNotable = data.also_notable || [];
  const filteredNotable = origNotable.filter((it) => {
    if (!q) return true;
    return (it.title || "").toLowerCase().includes(q) || (it.source || "").toLowerCase().includes(q);
  });

  const catNames = Object.keys(filteredCats);

  catNames.forEach((name) => {
    board.appendChild(renderCategory(name, filteredCats[name], q));
  });

  if (filteredNotable.length) {
    board.appendChild(renderNotable(filteredNotable, q));
  }

  if (!catNames.length && !filteredNotable.length) {
    if (q) {
      board.innerHTML = `<div class="state"><p>No items matching "<b>${escapeHtml(query)}</b>".</p></div>`;
    } else {
      board.innerHTML = `<div class="state">No items in this briefing.</div>`;
    }
  }

  // header meta
  const tag = $("#statusTag");
  tag.textContent = "LIVE"; tag.dataset.state = "live";
  $("#dateStamp").textContent = data.date || "";
  $("#featCount").textContent = featTotal;
  $("#notableCount").textContent = filteredNotable.length;
  $("#catCount").textContent = catNames.length;
  
  if (data.generated_at) {
    const dt = new Date(data.generated_at);
    const pstString = dt.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short"
    }).replace(/,/g, "");
    $("#genStamp").textContent = "compiled " + pstString;
  } else {
    $("#genStamp").textContent = "";
  }
  
  $("#statBar").hidden = false;
  $("#searchBar").hidden = false;
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
    
    $("#searchInput").addEventListener("input", (e) => {
      if (currentData) render(currentData, e.target.value);
    });

    showIndex(0);
  } catch (e) {
    renderError(e.message);
  }
})();
