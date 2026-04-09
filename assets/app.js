// Masters Fantasy Pool — client-side renderer
//
// Reads data/scores.json (auto-updated by GitHub Actions) and data/entries.json
// (updated when the owner approves an entry issue) and renders the leaderboard.

const PENALTY_WD = 10; // strokes added on top of last to-par for WD/DQ
const PENALTY_NULL = 20; // strokes if the golfer never posted a score
const PICKS_REQUIRED = 6;
const BEST_OF = 4;

// ---------- helpers ----------
async function loadJson(path) {
  const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

function fmtToPar(n) {
  if (n == null) return "—";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- scoring ----------
function golferEffectiveScore(player) {
  // Returns { score, label, penalty: bool, status }
  if (!player) {
    return { score: PENALTY_NULL, label: "Not in field", penalty: true };
  }
  const s = player.scoreToPar;
  const status = player.status;

  if (status === "wd" || status === "dq" || status === "dns") {
    const base = s == null ? 0 : s;
    return {
      score: base + PENALTY_WD,
      label: `${fmtToPar(base)} (${status.toUpperCase()})`,
      penalty: true,
    };
  }

  if (s == null) {
    return { score: 0, label: "—", penalty: false };
  }
  return { score: s, label: fmtToPar(s), penalty: false };
}

function computeTeam(entry, byId) {
  const picks = entry.picks.map((pk) => {
    const player = byId.get(String(pk.id)) || null;
    const eff = golferEffectiveScore(player);
    return {
      id: pk.id,
      name: (player && player.name) || pk.name,
      position: player ? player.position : "—",
      thru: player ? player.thru : null,
      status: player ? player.status : "missing",
      ...eff,
    };
  });

  const sortedAsc = [...picks].sort((a, b) => a.score - b.score);
  // Mark the best four by object reference (picks and sortedAsc share refs).
  const countedSet = new Set(sortedAsc.slice(0, BEST_OF));
  picks.forEach((p) => (p.counted = countedSet.has(p)));
  const total = sortedAsc.slice(0, BEST_OF).reduce((s, p) => s + p.score, 0);

  return { ...entry, picks, total };
}

// ---------- renderers ----------
function renderHeader(t) {
  const status = document.getElementById("tournament-status");
  if (!t) {
    status.textContent = "Tournament data unavailable.";
    return;
  }
  const round = t.currentRound ? ` · Round ${t.currentRound}` : "";
  status.textContent = `${t.name} · ${t.statusDescription}${round}`;
  if (t.lastUpdated) {
    const d = new Date(t.lastUpdated);
    document.getElementById("last-updated").textContent =
      `Scores last refreshed ${d.toLocaleString()}`;
  }
}

function renderPoolStandings(entries, byId) {
  const root = document.getElementById("pool-standings");
  root.innerHTML = "";

  if (!entries.length) {
    root.appendChild(
      el("div", { class: "empty" }, [
        "No entries yet. Be the first — see the ",
        el("strong", {}, "Rules & how to enter"),
        " tab.",
      ]),
    );
    return;
  }

  const teams = entries.map((e) => computeTeam(e, byId));
  teams.sort((a, b) => a.total - b.total);

  // Assign ranks (handles ties)
  let lastTotal = null;
  let lastRank = 0;
  teams.forEach((t, i) => {
    if (t.total !== lastTotal) {
      lastRank = i + 1;
      lastTotal = t.total;
    }
    t.rank = lastRank;
  });
  const tieCounts = {};
  teams.forEach((t) => (tieCounts[t.rank] = (tieCounts[t.rank] || 0) + 1));

  for (const t of teams) {
    const rankLabel = (tieCounts[t.rank] > 1 ? "T" : "") + t.rank;
    const card = el("div", { class: "pool-entry" });

    card.appendChild(
      el("div", { class: "pool-entry-header" }, [
        el("span", { class: "rank" }, rankLabel),
        el("span", { class: "name" }, t.displayName),
        el("span", { class: "total" }, fmtToPar(t.total)),
      ]),
    );

    const table = el("table");
    const thead = el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Golfer"),
        el("th", {}, "Pos"),
        el("th", { class: "num" }, "Thru"),
        el("th", { class: "num" }, "Score"),
      ]),
    ]);
    table.appendChild(thead);

    const tbody = el("tbody");
    // Order picks: counted first (by score), then dropped
    const ordered = [...t.picks].sort((a, b) => {
      if (a.counted !== b.counted) return a.counted ? -1 : 1;
      return a.score - b.score;
    });
    for (const p of ordered) {
      const row = el("tr", { class: p.counted ? "counted" : "dropped" });
      const nameCell = el("td", { class: "name" }, p.name);
      if (p.penalty) {
        nameCell.appendChild(el("span", { class: "badge-penalty" }, "PEN"));
      }
      row.appendChild(nameCell);
      row.appendChild(el("td", {}, p.position || "—"));
      row.appendChild(
        el("td", { class: "num" }, p.thru != null ? String(p.thru) : "—"),
      );
      row.appendChild(el("td", { class: "num" }, p.label));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    root.appendChild(card);
  }
}

function renderLeaderboard(players) {
  const root = document.getElementById("leaderboard");
  root.innerHTML = "";

  if (!players.length) {
    root.appendChild(
      el("div", { class: "empty" }, "Tournament hasn't started yet."),
    );
    return;
  }

  const table = el("table", { class: "lb-table" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "pos" }, "Pos"),
        el("th", {}, "Player"),
        el("th", { class: "num" }, "Score"),
        el("th", { class: "num" }, "Thru"),
        el("th", {}, "R1"),
        el("th", {}, "R2"),
        el("th", {}, "R3"),
        el("th", {}, "R4"),
      ]),
    ]),
  );

  const tbody = el("tbody");
  for (const p of players) {
    const isCut =
      p.status === "cut" || p.status === "wd" || p.status === "dq";
    const row = el("tr", isCut ? { class: "cut" } : {});
    row.appendChild(el("td", { class: "pos" }, p.position || "—"));
    row.appendChild(el("td", {}, p.name || "—"));
    row.appendChild(el("td", { class: "num" }, fmtToPar(p.scoreToPar)));
    row.appendChild(
      el(
        "td",
        { class: "num" },
        p.thru != null ? String(p.thru) : isCut ? p.status.toUpperCase() : "—",
      ),
    );
    for (let i = 0; i < 4; i++) {
      const r = (p.rounds || [])[i];
      row.appendChild(el("td", { class: "num" }, r != null ? String(r) : "—"));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

function renderRejected(rejected) {
  const root = document.getElementById("pending-fixes");
  root.innerHTML = "";
  if (!rejected || !rejected.length) return;

  const header = el("h2", { class: "pending-header" }, [
    "Pending fixes ",
    el("span", { class: "pending-count" }, `(${rejected.length})`),
  ]);
  root.appendChild(header);

  root.appendChild(
    el(
      "p",
      { class: "pending-hint" },
      "These form submissions couldn't be matched against the field. The friend " +
        "should resubmit the form using the same display name (latest submission " +
        "replaces the old one). Owner can also fix names directly in the linked " +
        "Google Sheet.",
    ),
  );

  for (const r of rejected) {
    const card = el("div", { class: "rejected-entry" });
    card.appendChild(
      el("div", { class: "rejected-entry-header" }, [
        el("span", { class: "name" }, r.displayName || "(no name)"),
        r.submittedAt
          ? el(
              "span",
              { class: "ts" },
              new Date(r.submittedAt).toLocaleString(),
            )
          : null,
      ]),
    );

    // Map errors by pickIndex for fast lookup
    const errsByPick = new Map();
    let entryLevelErrors = [];
    for (const e of r.errors || []) {
      if (e.pickIndex && e.pickIndex >= 1 && e.pickIndex <= 6) {
        errsByPick.set(e.pickIndex, e);
      } else {
        entryLevelErrors.push(e);
      }
    }

    const list = el("ol", { class: "rejected-picks" });
    const raw = r.rawPicks || [];
    for (let i = 0; i < 6; i++) {
      const text = raw[i] || "";
      const err = errsByPick.get(i + 1);
      if (err) {
        const li = el("li", { class: "bad" }, [
          el("span", { class: "input" }, text || "(empty)"),
          el("span", { class: "msg" }, err.message),
        ]);
        list.appendChild(li);
      } else {
        list.appendChild(
          el("li", { class: "ok" }, [el("span", { class: "input" }, text)]),
        );
      }
    }
    card.appendChild(list);

    for (const e of entryLevelErrors) {
      card.appendChild(
        el("p", { class: "entry-error" }, e.message),
      );
    }

    root.appendChild(card);
  }
}

let allFieldPlayers = [];
function renderField(players) {
  allFieldPlayers = players.slice();
  // Alphabetize for the picker view
  allFieldPlayers.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  drawFieldList(allFieldPlayers);
}

function drawFieldList(list) {
  const root = document.getElementById("field-list");
  root.innerHTML = "";
  if (!list.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No players match that search."),
    );
    return;
  }
  const table = el("table", { class: "field-table" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Player"),
        el("th", {}, "Country"),
      ]),
    ]),
  );
  const tbody = el("tbody");
  for (const p of list) {
    tbody.appendChild(
      el("tr", {}, [
        el("td", {}, p.name || "—"),
        el("td", {}, p.country || ""),
      ]),
    );
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

// ---------- tabs + setup ----------
function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".tab-panel");
  tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    }),
  );
  document.querySelectorAll("[data-jump]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = a.getAttribute("data-jump");
      document.querySelector(`.tab[data-tab="${target}"]`).click();
    }),
  );
}

function wireRepoLinks() {
  // Detect repo from the current GitHub Pages URL so the README placeholder
  // doesn't have to be hand-edited.
  const host = location.hostname; // e.g. user.github.io
  const path = location.pathname.replace(/^\/+|\/+$/g, "").split("/");
  let owner = null;
  let repo = null;
  if (host.endsWith(".github.io")) {
    owner = host.split(".")[0];
    repo = path[0] || `${owner}.github.io`;
  }
  if (owner && repo) {
    const base = `https://github.com/${owner}/${repo}`;
    document.getElementById("repo-link").href = base;
    document.getElementById("entry-link").href =
      `${base}/issues/new?template=pool-entry.yml`;
  } else {
    // Local preview — leave a sensible default
    document.getElementById("repo-link").href = "https://github.com";
    document.getElementById("entry-link").href = "https://github.com";
  }
}

function wireFieldSearch() {
  const input = document.getElementById("field-search");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return drawFieldList(allFieldPlayers);
    drawFieldList(
      allFieldPlayers.filter(
        (p) =>
          (p.name || "").toLowerCase().includes(q) ||
          (p.country || "").toLowerCase().includes(q),
      ),
    );
  });
}

async function main() {
  wireTabs();
  wireRepoLinks();
  wireFieldSearch();

  let scores, entriesData;
  try {
    [scores, entriesData] = await Promise.all([
      loadJson("data/scores.json"),
      loadJson("data/entries.json").catch(() => ({ entries: [] })),
    ]);
  } catch (e) {
    const err = document.getElementById("error");
    err.textContent =
      e.message + " — the workflow may not have run yet. Try again shortly.";
    err.hidden = false;
    return;
  }

  const players = scores.players || [];
  const byId = new Map(players.map((p) => [String(p.id), p]));

  renderHeader(scores.tournament);
  renderPoolStandings(entriesData.entries || [], byId);
  renderRejected(entriesData.rejected || []);
  renderLeaderboard(players);
  renderField(players);
}

main();
