// Masters Fantasy Pool — client-side renderer
//
// Reads data/scores.json (auto-updated by GitHub Actions) and data/entries.json
// (updated when the owner approves an entry issue) and renders the leaderboard.

const PENALTY_WD = 10; // strokes added on top of last to-par for WD/DQ
const PENALTY_NULL = 20; // strokes if the golfer never posted a score
// Each round a cut player didn't play is treated as if they shot an 80
// (par 72 at Augusta + 8). Cut always means 2 missed weekend rounds, so
// the effective penalty is +16 on top of the 36-hole to-par.
const CUT_ROUND_ASSUMED_TO_PAR = 8;
const CUT_MISSED_ROUNDS = 2;
const PICKS_REQUIRED = 6;
const BEST_OF = 4;

// Google Form prefill mapping. The form's entry IDs were captured from a
// "Get pre-filled link" URL — if you ever rebuild the form, regenerate these.
const FORM_PREFILL = {
  base: "https://docs.google.com/forms/d/e/1FAIpQLSeelvfCHACF3PS6APNsjlpASJfIRR4fNuQj2wKsIAoZdqa6dQ/viewform",
  displayName: "entry.1320310589",
  picks: [
    "entry.1445693168",
    "entry.1565091201",
    "entry.159174347",
    "entry.693170565",
    "entry.1082352039",
    "entry.1944105469",
  ],
};

// Submission deadline. Must match SUBMISSION_CUTOFF in scripts/poll_form.py.
// 10:00 AM Eastern on Thursday April 9, 2026 == 14:00 UTC April 9, 2026.
const SUBMISSION_CUTOFF = new Date("2026-04-09T14:00:00Z");

// ---------- Sunday Showdown sidecar ----------
// Three sub-contests on a single secondary form, all scored on R4 only:
//   1. Pick 3:        sum of three R4 to-pars, lowest wins (no drops).
//   2. Champion Call: pick the winner + a winning to-par tiebreak guess.
//   3. Boom Holes:    one golfer's combined strokes-to-par on a fixed set
//                     of "boom" holes (the back-nine drama holes).
const PICK3_REQUIRED = 3;
const BOOM_HOLES = [12, 13, 15, 16, 18];
const SHOWDOWN_PENALTY_WD = 10;

// Submission deadline for the showdown. Must match SUBMISSION_CUTOFF in
// scripts/poll_showdown.py. 10:30 AM Eastern (EDT) on Sunday April 12, 2026
// == 14:30 UTC April 12, 2026.
const SHOWDOWN_CUTOFF = new Date("2026-04-12T14:30:00Z");

// Google Form prefill IDs for the Sunday Showdown form. PLACEHOLDERS — to
// activate the picker, create a Google Form with these short-answer
// questions in this order:
//   Display name, Pick 1, Pick 2, Pick 3, Champion,
//   Winning to-par guess, Boom Holes pick
// Then "Get pre-filled link", fill in any values, copy the URL, and replace
// the entry IDs below with the ones from that URL. The picker auto-hides
// itself until the base URL is changed away from the placeholder.
const SHOWDOWN_FORM_PREFILL = {
  base: "https://docs.google.com/forms/d/e/REPLACE_WITH_SHOWDOWN_FORM_ID/viewform",
  displayName: "entry.REPLACE_DISPLAY_NAME",
  pick3: [
    "entry.REPLACE_PICK_1",
    "entry.REPLACE_PICK_2",
    "entry.REPLACE_PICK_3",
  ],
  champion: "entry.REPLACE_CHAMPION",
  championGuess: "entry.REPLACE_GUESS",
  boomHoles: "entry.REPLACE_BOOM_HOLES",
};

function isShowdownConfigured() {
  return !SHOWDOWN_FORM_PREFILL.base.includes("REPLACE_");
}

function isShowdownPastCutoff() {
  return Date.now() >= SHOWDOWN_CUTOFF.getTime();
}

function formatShowdownCutoffLocal() {
  try {
    return SHOWDOWN_CUTOFF.toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch (e) {
    return SHOWDOWN_CUTOFF.toString();
  }
}

// Augusta National par per hole. Used as a fallback when no rounds have
// been played yet (so we can still draw the par row in the scorecard modal),
// and as the authoritative par source for Boom Holes scoring before any R4
// holes have been posted. Hole 12 (Golden Bell) is par 3 and hole 13
// (Azalea) is par 5 — get the order right or the back nine math breaks.
const AUGUSTA_PAR = [4, 5, 4, 3, 4, 3, 4, 5, 4, 4, 4, 3, 5, 4, 5, 3, 4, 4];

// ESPN core API exposes per-competitor hole-by-hole linescores. CORS-open.
const SCORECARD_URL = (eventId, athleteId) =>
  `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${eventId}/competitions/${eventId}/competitors/${athleteId}/linescores`;

// Stashed when scores.json loads so renderers don't have to thread eventId
// through every call site. Reset on every refresh.
let currentEventId = null;

function isPastCutoff() {
  return Date.now() >= SUBMISSION_CUTOFF.getTime();
}

function formatCutoffLocal() {
  // Render the deadline in the visitor's local time.
  try {
    return SUBMISSION_CUTOFF.toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch (e) {
    return SUBMISSION_CUTOFF.toString();
  }
}

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

// Returns a small round headshot <img> for an ESPN golfer id, or null. The
// URL pattern is ESPN's standard headshot CDN; if a player has no portrait
// uploaded the onerror handler hides the img so it doesn't leave a broken
// icon in the row.
function playerAvatar(id) {
  if (!id) return null;
  const img = document.createElement("img");
  img.className = "player-avatar";
  img.src = `https://a.espncdn.com/i/headshots/golf/players/full/${id}.png`;
  img.alt = "";
  img.loading = "lazy";
  img.onerror = function () {
    this.style.display = "none";
  };
  return img;
}

// Returns a clickable button styled as a player-name link. Wraps an optional
// avatar + the player name. Skips wiring the click if we don't have both an
// athlete id and an event id (e.g. for picks whose golfer isn't in the field).
function playerNameLink(player, opts = {}) {
  const id = player && player.id != null ? String(player.id) : null;
  const name = (player && player.name) || "—";
  const eventId = opts.eventId || currentEventId;

  const wantAvatar = opts.avatar !== false;
  const avatar = wantAvatar && id ? playerAvatar(id) : null;

  if (!id || !eventId) {
    // Not clickable — render as a span so layout matches the link version.
    const span = document.createElement("span");
    span.className = "player-link disabled";
    if (avatar) span.appendChild(avatar);
    span.appendChild(document.createTextNode(name));
    return span;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "player-link";
  if (avatar) btn.appendChild(avatar);
  btn.appendChild(document.createTextNode(name));
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openScorecardModal(player, eventId);
  });
  return btn;
}

// Hits ESPN's per-competitor linescores endpoint and returns the items[]
// array (one entry per round). Throws on non-2xx so the caller can show an
// error state.
async function fetchScorecard(eventId, athleteId) {
  const res = await fetch(SCORECARD_URL(eventId, athleteId), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`scorecard ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// Pull the par row from the first round that has linescores. If nothing has
// been played yet, fall back to the static Augusta par.
function parsePar(items) {
  for (const round of items || []) {
    const ls = round && round.linescores;
    if (ls && ls.length) {
      const par = new Array(18).fill(null);
      for (const h of ls) {
        const hole = h.period;
        if (hole >= 1 && hole <= 18 && typeof h.par === "number") {
          par[hole - 1] = h.par;
        }
      }
      // Fill any gaps from Augusta defaults so the par row is always complete.
      for (let i = 0; i < 18; i++) {
        if (par[i] == null) par[i] = AUGUSTA_PAR[i];
      }
      return par;
    }
  }
  return AUGUSTA_PAR.slice();
}

// Map ESPN's scoreType.name into a CSS modifier so the cell can be color-coded.
function holeClass(scoreType) {
  const name = (scoreType && scoreType.name) || "";
  if (name === "EAGLE" || name === "DOUBLE_EAGLE") return "hole-eagle";
  if (name === "BIRDIE") return "hole-birdie";
  if (name === "PAR") return "hole-par";
  if (name === "BOGEY") return "hole-bogey";
  if (name === "DOUBLE_BOGEY" || name === "TRIPLE_BOGEY" || name === "OTHER")
    return "hole-double";
  return "";
}

// Render a 2x9 hole grid for one round (par row + strokes row, with In/Out/Tot
// totals). `holes` is keyed by hole number 1..18 from the round's linescores.
function renderRoundGrid(par, holes, round) {
  const wrap = el("div", { class: "scorecard-round" });

  const titleParts = [`Round ${round.period}`];
  if (round.displayValue) titleParts.push(`(${round.displayValue})`);
  wrap.appendChild(el("h3", { class: "scorecard-round-title" }, titleParts.join(" ")));

  const buildHalf = (start) => {
    const table = el("table", { class: "scorecard-grid" });
    const headRow = el("tr", {}, [el("th", {}, "Hole")]);
    for (let i = start; i < start + 9; i++) {
      headRow.appendChild(el("th", {}, String(i + 1)));
    }
    headRow.appendChild(el("th", { class: "scorecard-total" }, start === 0 ? "Out" : "In"));
    table.appendChild(headRow);

    const parRow = el("tr", { class: "scorecard-par-row" }, [el("th", {}, "Par")]);
    let parTotal = 0;
    for (let i = start; i < start + 9; i++) {
      parRow.appendChild(el("td", {}, String(par[i])));
      parTotal += par[i];
    }
    parRow.appendChild(el("td", { class: "scorecard-total" }, String(parTotal)));
    table.appendChild(parRow);

    const scoreRow = el("tr", { class: "scorecard-score-row" }, [el("th", {}, "Score")]);
    let scoreTotal = 0;
    let anyScore = false;
    for (let i = start; i < start + 9; i++) {
      const h = holes[i + 1];
      if (h) {
        anyScore = true;
        scoreTotal += h.value || 0;
        const td = el("td", { class: holeClass(h.scoreType) }, String(h.value));
        scoreRow.appendChild(td);
      } else {
        scoreRow.appendChild(el("td", { class: "hole-empty" }, "—"));
      }
    }
    // Prefer ESPN's outScore/inScore when present (handles in-progress rounds).
    let half = anyScore ? scoreTotal : null;
    if (start === 0 && typeof round.outScore === "number") half = round.outScore;
    if (start === 9 && typeof round.inScore === "number") half = round.inScore;
    scoreRow.appendChild(
      el("td", { class: "scorecard-total" }, half != null ? String(half) : "—"),
    );
    table.appendChild(scoreRow);
    return table;
  };

  wrap.appendChild(buildHalf(0));
  wrap.appendChild(buildHalf(9));

  // Round total line
  if (typeof round.value === "number" && round.value > 0) {
    wrap.appendChild(
      el(
        "p",
        { class: "scorecard-round-total" },
        `Total: ${round.value}${round.displayValue ? " (" + round.displayValue + ")" : ""}`,
      ),
    );
  }

  return wrap;
}

let scorecardKeyHandler = null;
function closeScorecardModal() {
  const existing = document.querySelector(".scorecard-backdrop");
  if (existing) existing.remove();
  if (scorecardKeyHandler) {
    document.removeEventListener("keydown", scorecardKeyHandler);
    scorecardKeyHandler = null;
  }
  document.body.classList.remove("scorecard-open");
}

function openScorecardModal(player, eventId) {
  // Replace any existing modal so a second click swaps content cleanly.
  closeScorecardModal();

  const backdrop = el("div", { class: "scorecard-backdrop" });
  const modal = el("div", { class: "scorecard-modal" });

  // Header
  const header = el("div", { class: "scorecard-header" });
  const avatar = playerAvatar(player.id);
  if (avatar) {
    avatar.classList.add("player-avatar-large");
    header.appendChild(avatar);
  }
  const headerText = el("div", { class: "scorecard-header-text" });
  headerText.appendChild(el("h2", {}, player.name || "Player"));
  const subParts = [];
  if (player.country) subParts.push(player.country);
  if (player.position) subParts.push(player.position);
  if (player.scoreToPar != null) subParts.push(fmtToPar(player.scoreToPar));
  if (subParts.length) {
    headerText.appendChild(el("p", { class: "scorecard-sub" }, subParts.join(" · ")));
  }
  header.appendChild(headerText);

  const closeBtn = el("button", { class: "scorecard-close", "aria-label": "Close" }, "×");
  closeBtn.addEventListener("click", closeScorecardModal);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body — initial loading state
  const body = el("div", { class: "scorecard-body" });
  body.appendChild(el("p", { class: "scorecard-loading" }, "Loading scorecard…"));
  modal.appendChild(body);

  backdrop.appendChild(modal);
  // Backdrop click closes; clicks inside the modal should not.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeScorecardModal();
  });
  document.body.appendChild(backdrop);
  document.body.classList.add("scorecard-open");

  scorecardKeyHandler = (e) => {
    if (e.key === "Escape") closeScorecardModal();
  };
  document.addEventListener("keydown", scorecardKeyHandler);

  // Fetch and render
  fetchScorecard(eventId, player.id)
    .then((items) => {
      body.innerHTML = "";
      if (!items.length) {
        body.appendChild(
          el("p", { class: "scorecard-error" }, "Scorecard not available yet."),
        );
        return;
      }
      const par = parsePar(items);
      // Sort rounds by period to be safe.
      const rounds = items.slice().sort((a, b) => (a.period || 0) - (b.period || 0));
      for (const round of rounds) {
        const holes = {};
        for (const h of round.linescores || []) {
          if (h && h.period) holes[h.period] = h;
        }
        body.appendChild(renderRoundGrid(par, holes, round));
      }
    })
    .catch((err) => {
      console.error("scorecard fetch failed:", err);
      body.innerHTML = "";
      body.appendChild(
        el("p", { class: "scorecard-error" }, "Scorecard not available."),
      );
    });
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

  if (status === "cut") {
    // Cut players are scored as if they shot CUT_ROUND_ASSUMED_TO_PAR for
    // each of the two weekend rounds they didn't play. Their team-total
    // score reflects the full 4-round assumed cumulative.
    const base = s == null ? 0 : s;
    const adjusted = base + CUT_MISSED_ROUNDS * CUT_ROUND_ASSUMED_TO_PAR;
    return {
      score: adjusted,
      label: `${fmtToPar(adjusted)} (CUT)`,
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

// ---------- showdown scoring ----------
// Three sub-contests, all scored against R4 only. Each compute* function
// takes a raw entry from data/showdown.json and returns a scored shape that
// the corresponding renderer knows how to draw.

function scoreShowdownGolferR4(pk, player) {
  // Returns the R4 to-par for one golfer pick, with WD/DQ penalty.
  if (!player) {
    return {
      id: pk.id,
      name: pk.name,
      score: PENALTY_NULL,
      label: "Not in field",
      penalty: true,
      status: "missing",
      thru: null,
    };
  }
  const r4 = (player.rounds || [])[3];
  const status = player.status;
  if (status === "wd" || status === "dq") {
    const base = r4 == null ? 0 : r4;
    return {
      id: pk.id,
      name: player.name,
      score: base + SHOWDOWN_PENALTY_WD,
      label: `${fmtToPar(base)} (${status.toUpperCase()})`,
      penalty: true,
      status,
      thru: player.thru,
    };
  }
  if (r4 == null) {
    return {
      id: pk.id,
      name: player.name,
      score: 0,
      label: "—",
      penalty: false,
      status,
      thru: player.thru,
    };
  }
  return {
    id: pk.id,
    name: player.name,
    score: r4,
    label: fmtToPar(r4),
    penalty: false,
    status,
    thru: player.thru,
  };
}

function computeShowdownPick3(entry, byId) {
  const picks = (entry.pick3 || []).map((pk) => {
    const player = byId.get(String(pk.id)) || null;
    return scoreShowdownGolferR4(pk, player);
  });
  const total = picks.reduce((s, p) => s + p.score, 0);
  // Tiebreak = full R4 of pick #1 (lower is better). Used by the standings
  // render to break ties; surfaced as `tiebreak` for display.
  const firstPickFull = picks[0] ? picks[0].score : 0;
  return { ...entry, scoredPicks: picks, total, tiebreak: firstPickFull };
}

function scoreShowdownBoomHoles(pk, player) {
  // Returns combined strokes-to-par on BOOM_HOLES, plus per-hole detail for
  // the standings table. Holes the golfer hasn't played yet are simply
  // omitted from the running total — partial scores are shown live.
  if (!player) {
    return {
      id: pk.id,
      name: pk.name,
      score: PENALTY_NULL,
      label: "Not in field",
      penalty: true,
      holesPlayed: 0,
      holes: [],
      r4Total: PENALTY_NULL,
    };
  }
  const status = player.status;
  if (status === "wd" || status === "dq") {
    return {
      id: pk.id,
      name: player.name,
      score: SHOWDOWN_PENALTY_WD,
      label: `${status.toUpperCase()} +${SHOWDOWN_PENALTY_WD}`,
      penalty: true,
      holesPlayed: 0,
      holes: [],
      r4Total: SHOWDOWN_PENALTY_WD,
    };
  }
  const r4Holes = player.r4Holes || new Array(18).fill(null);
  let total = 0;
  let played = 0;
  const holes = [];
  for (const holeNum of BOOM_HOLES) {
    const idx = holeNum - 1;
    const strokes = r4Holes[idx];
    const par = AUGUSTA_PAR[idx];
    if (strokes != null) {
      total += strokes - par;
      played += 1;
    }
    holes.push({ hole: holeNum, strokes, par });
  }
  const r4 = (player.rounds || [])[3];
  return {
    id: pk.id,
    name: player.name,
    score: total,
    label: played === 0 ? "—" : fmtToPar(total),
    penalty: false,
    holesPlayed: played,
    holes,
    r4Total: r4 == null ? 0 : r4, // tiebreak: full R4 to-par
    status,
    thru: player.thru,
  };
}

function computeShowdownChampion(entry, players, tournament) {
  // Determine the actual winner. We only crown a winner if the tournament is
  // marked "post" (final). Mid-tournament we still compute predicted-correct
  // and signed diff so the live leaderboard shows current standings.
  const isFinal = tournament && tournament.status === "post";
  let actualWinner = null;
  let actualWinningToPar = null;
  if (players && players.length) {
    const eligible = players
      .filter(
        (p) =>
          p.scoreToPar != null &&
          p.status !== "cut" &&
          p.status !== "wd" &&
          p.status !== "dq",
      )
      .sort((a, b) => a.scoreToPar - b.scoreToPar);
    if (eligible.length) {
      actualWinner = eligible[0];
      actualWinningToPar = eligible[0].scoreToPar;
    }
  }

  const champ = entry.champion || {};
  const correct =
    actualWinner && String(actualWinner.id) === String(champ.id);

  let signedDiff = null;
  let absDiff = null;
  let overshot = false;
  if (actualWinningToPar != null && entry.championGuess != null) {
    // signedDiff = guess - actual (in to-par space).
    // Positive = predicted a worse score than they actually shot
    //           (acceptable / "didn't go over" in PriceIsRight rules).
    // Negative = predicted a better score than they actually shot
    //           ("went over" — disqualified for tiebreak unless nobody is OK).
    signedDiff = entry.championGuess - actualWinningToPar;
    absDiff = Math.abs(signedDiff);
    overshot = signedDiff < 0;
  }

  return {
    displayName: entry.displayName,
    pickName: champ.name || "—",
    pickId: champ.id,
    guess: entry.championGuess,
    actualWinner,
    actualWinningToPar,
    isFinal,
    correct: !!correct,
    signedDiff,
    absDiff,
    overshot,
  };
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

function renderPreCutoffEntries(root, entries) {
  const card = el("div", { class: "precutoff" });
  card.appendChild(
    el("h2", { class: "precutoff-title" }, "Picks are hidden until the deadline"),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-body" },
      `Teams unlock at ${formatCutoffLocal()}. Until then you'll just see who has entered.`,
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-count" },
      `${entries.length} ${entries.length === 1 ? "entry" : "entries"} submitted so far`,
    ),
  );

  const list = el("ul", { class: "precutoff-list" });
  // Sort alphabetically by display name so the order doesn't leak submission timing.
  const names = entries
    .map((e) => e.displayName || "(no name)")
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    list.appendChild(el("li", {}, name));
  }
  card.appendChild(list);
  root.appendChild(card);
}

function renderPoolStandings(entries, byId) {
  const root = document.getElementById("pool-standings");
  root.innerHTML = "";

  // Hide the "best 4 of 6 / shaded in green" hint pre-cutoff — it's confusing
  // when there are no picks displayed.
  const hint = document.getElementById("pool-hint");
  if (hint) hint.hidden = !isPastCutoff();

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

  // Before the submission deadline, show only the list of submitters — no
  // picks, no scores. Keeps people from copying each other's teams.
  if (!isPastCutoff()) {
    renderPreCutoffEntries(root, entries);
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
      ])
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
      const nameCell = el("td", { class: "name" });
      // Prefer the full player object from byId so the modal header has
      // country / scoreToPar; fall back to the slimmed-down pick.
      const fullPlayer = byId.get(String(p.id)) || p;
      nameCell.appendChild(playerNameLink(fullPlayer));
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
    const lbNameCell = el("td", { class: "player" });
    lbNameCell.appendChild(playerNameLink(p));
    row.appendChild(lbNameCell);
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
      row.appendChild(el("td", { class: "num" }, fmtToPar(r)));
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

// ---------- showdown renderers ----------
// One top-level entry point (`renderShowdown`) that paints the full Sunday
// Showdown tab, then three sub-renderers — one per sub-contest.

function renderShowdown(showdownData, players, byId, tournament) {
  const entries = (showdownData && showdownData.entries) || [];
  const rejected = (showdownData && showdownData.rejected) || [];
  const root = document.getElementById("showdown-content");
  if (!root) return;
  root.innerHTML = "";

  // Always-visible explainer card so the boys remember what game this is.
  root.appendChild(renderShowdownExplainer());

  // Pre-cutoff: just show the entrant list (no picks leaked).
  if (!isShowdownPastCutoff()) {
    root.appendChild(renderShowdownPreCutoff(entries));
    if (rejected.length) {
      root.appendChild(renderShowdownRejected(rejected));
    }
    return;
  }

  if (!entries.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "No showdown entries yet. Picks are due by " +
          formatShowdownCutoffLocal() +
          ".",
      ),
    );
    if (rejected.length) {
      root.appendChild(renderShowdownRejected(rejected));
    }
    return;
  }

  root.appendChild(renderPick3Standings(entries, byId));
  root.appendChild(renderBoomHolesStandings(entries, byId));
  root.appendChild(renderChampionStandings(entries, players, tournament));

  if (rejected.length) {
    root.appendChild(renderShowdownRejected(rejected));
  }
}

function renderShowdownExplainer() {
  const card = el("div", { class: "showdown-explainer" });
  card.appendChild(el("h2", {}, "Sunday Showdown"));
  card.appendChild(
    el(
      "p",
      { class: "hint" },
      "Three secondary contests, all scored on Sunday's final round only. " +
        "One Google Form, one set of picks, three leaderboards.",
    ),
  );
  const ul = el("ul", { class: "showdown-rules" });
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Pick 3: "),
      "sum of three R4 to-pars. No drops. Lowest wins. Tiebreak: full R4 of pick #1.",
    ]),
  );
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Champion Call: "),
      "pick the outright winner + a winning to-par guess. Closest correct guess " +
        "without going over (Price-Is-Right rules) wins.",
    ]),
  );
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Boom Holes: "),
      "one golfer's combined strokes-to-par on holes " +
        BOOM_HOLES.join(", ") +
        ". Lowest wins. Tiebreak: full R4 to-par.",
    ]),
  );
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Cut survivors only: "),
      "you can't pick a golfer who got cut.",
    ]),
  );
  card.appendChild(ul);
  return card;
}

function renderShowdownPreCutoff(entries) {
  const card = el("div", { class: "precutoff" });
  card.appendChild(
    el(
      "h2",
      { class: "precutoff-title" },
      "Showdown picks are hidden until the deadline",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-body" },
      `Teams unlock at ${formatShowdownCutoffLocal()}. Until then you'll just ` +
        "see who has entered.",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-count" },
      `${entries.length} ${entries.length === 1 ? "entry" : "entries"} submitted so far`,
    ),
  );
  const list = el("ul", { class: "precutoff-list" });
  const names = entries
    .map((e) => e.displayName || "(no name)")
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    list.appendChild(el("li", {}, name));
  }
  card.appendChild(list);
  return card;
}

function renderPick3Standings(entries, byId) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(el("h2", { class: "showdown-section-title" }, "Pick 3"));
  wrap.appendChild(
    el(
      "p",
      { class: "hint" },
      "Sum of all 3 R4 to-pars. Lowest wins. Tiebreak: full R4 of pick #1.",
    ),
  );

  const teams = entries.map((e) => computeShowdownPick3(e, byId));
  // Sort: total asc, then tiebreak asc, then displayName for stability
  teams.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    if (a.tiebreak !== b.tiebreak) return a.tiebreak - b.tiebreak;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  // Assign ranks (ties share a rank, no skip-ahead)
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
    table.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "Golfer"),
          el("th", {}, "Pos"),
          el("th", { class: "num" }, "Thru"),
          el("th", { class: "num" }, "R4"),
        ]),
      ]),
    );
    const tbody = el("tbody");
    t.scoredPicks.forEach((p, idx) => {
      const row = el("tr");
      const nameCell = el("td", { class: "name" });
      const fullPlayer = byId.get(String(p.id)) || p;
      nameCell.appendChild(playerNameLink(fullPlayer));
      if (idx === 0) {
        nameCell.appendChild(
          el("span", { class: "badge-tiebreak" }, "TB"),
        );
      }
      if (p.penalty) {
        nameCell.appendChild(el("span", { class: "badge-penalty" }, "PEN"));
      }
      row.appendChild(nameCell);
      const fp = byId.get(String(p.id));
      row.appendChild(el("td", {}, (fp && fp.position) || "—"));
      row.appendChild(
        el(
          "td",
          { class: "num" },
          p.thru != null ? String(p.thru) : "—",
        ),
      );
      row.appendChild(el("td", { class: "num" }, p.label));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    wrap.appendChild(card);
  }
  return wrap;
}

function renderBoomHolesStandings(entries, byId) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(
    el("h2", { class: "showdown-section-title" }, "Boom Holes"),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "hint" },
      "One golfer, sum of strokes-to-par on holes " +
        BOOM_HOLES.join(", ") +
        ". Lowest wins. Tiebreak: full R4 to-par.",
    ),
  );

  const scored = entries.map((e) => {
    const player = byId.get(String((e.boomHoles || {}).id)) || null;
    return {
      displayName: e.displayName,
      golfer: scoreShowdownBoomHoles(e.boomHoles || {}, player),
    };
  });
  scored.sort((a, b) => {
    if (a.golfer.score !== b.golfer.score)
      return a.golfer.score - b.golfer.score;
    if (a.golfer.r4Total !== b.golfer.r4Total)
      return a.golfer.r4Total - b.golfer.r4Total;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  let lastScore = null;
  let lastRank = 0;
  scored.forEach((s, i) => {
    if (s.golfer.score !== lastScore) {
      lastRank = i + 1;
      lastScore = s.golfer.score;
    }
    s.rank = lastRank;
  });
  const tieCounts = {};
  scored.forEach((s) => (tieCounts[s.rank] = (tieCounts[s.rank] || 0) + 1));

  const table = el("table", { class: "boom-table" });
  const headRow = el("tr", {}, [
    el("th", {}, "Rank"),
    el("th", {}, "Player"),
    el("th", {}, "Golfer"),
  ]);
  for (const h of BOOM_HOLES) {
    headRow.appendChild(el("th", { class: "num" }, "H" + h));
  }
  headRow.appendChild(el("th", { class: "num" }, "To Par"));
  headRow.appendChild(el("th", { class: "num" }, "Full R4"));
  table.appendChild(el("thead", {}, headRow));

  const tbody = el("tbody");
  for (const s of scored) {
    const rankLabel = (tieCounts[s.rank] > 1 ? "T" : "") + s.rank;
    const row = el("tr");
    row.appendChild(el("td", { class: "rank" }, rankLabel));
    row.appendChild(el("td", { class: "name" }, s.displayName));
    const golferCell = el("td", { class: "name" });
    const fullPlayer = byId.get(String(s.golfer.id)) || s.golfer;
    golferCell.appendChild(playerNameLink(fullPlayer));
    if (s.golfer.penalty) {
      golferCell.appendChild(el("span", { class: "badge-penalty" }, "PEN"));
    }
    row.appendChild(golferCell);
    for (const h of s.golfer.holes) {
      const td = el("td", { class: "num" });
      if (h.strokes == null) {
        td.textContent = "—";
      } else {
        const diff = h.strokes - h.par;
        td.textContent = String(h.strokes);
        td.classList.add(holeClassFromDiff(diff));
      }
      row.appendChild(td);
    }
    row.appendChild(el("td", { class: "num" }, s.golfer.label));
    row.appendChild(
      el(
        "td",
        { class: "num" },
        s.golfer.r4Total === SHOWDOWN_PENALTY_WD || s.golfer.score === PENALTY_NULL
          ? "—"
          : fmtToPar(s.golfer.r4Total),
      ),
    );
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function holeClassFromDiff(diff) {
  if (diff <= -2) return "hole-eagle";
  if (diff === -1) return "hole-birdie";
  if (diff === 0) return "hole-par";
  if (diff === 1) return "hole-bogey";
  return "hole-double";
}

function renderChampionStandings(entries, players, tournament) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(
    el("h2", { class: "showdown-section-title" }, "Champion Call"),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "hint" },
      "Pick the outright winner + a winning to-par guess. Among entries that " +
        "picked the actual winner, closest guess without going over (Price-Is-Right) wins.",
    ),
  );

  const scored = entries.map((e) =>
    computeShowdownChampion(e, players, tournament),
  );

  // Surface the actual winner state at the top of the section.
  const first = scored[0];
  if (first && first.actualWinner) {
    wrap.appendChild(
      el(
        "p",
        { class: "champion-actual" },
        first.isFinal
          ? `Winner: ${first.actualWinner.name} at ${fmtToPar(first.actualWinningToPar)}`
          : `Current leader: ${first.actualWinner.name} at ${fmtToPar(first.actualWinningToPar)} (not final yet)`,
      ),
    );
  }

  // Sort: correct picks first, then by (not-overshot, abs diff)
  // Among incorrect picks, sort by abs diff so the live board still ranks them.
  scored.sort((a, b) => {
    if (a.correct !== b.correct) return a.correct ? -1 : 1;
    if (a.absDiff == null && b.absDiff == null) return 0;
    if (a.absDiff == null) return 1;
    if (b.absDiff == null) return -1;
    if (a.overshot !== b.overshot) return a.overshot ? 1 : -1;
    return a.absDiff - b.absDiff;
  });

  const table = el("table", { class: "champion-table" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Rank"),
        el("th", {}, "Player"),
        el("th", {}, "Their Pick"),
        el("th", { class: "num" }, "Guess"),
        el("th", { class: "num" }, "Diff"),
        el("th", {}, "Status"),
      ]),
    ]),
  );
  const tbody = el("tbody");
  scored.forEach((s, i) => {
    const row = el("tr");
    row.appendChild(el("td", { class: "rank" }, String(i + 1)));
    row.appendChild(el("td", { class: "name" }, s.displayName));
    row.appendChild(el("td", {}, s.pickName));
    row.appendChild(
      el("td", { class: "num" }, s.guess == null ? "—" : fmtToPar(s.guess)),
    );
    row.appendChild(
      el(
        "td",
        { class: "num" },
        s.signedDiff == null
          ? "—"
          : (s.signedDiff > 0 ? "+" : "") + s.signedDiff,
      ),
    );
    let statusText = "—";
    if (s.actualWinner == null) {
      statusText = "pending";
    } else if (!s.correct) {
      statusText = "wrong winner";
    } else if (s.overshot) {
      statusText = "overshot";
    } else {
      statusText = s.signedDiff === 0 ? "exact!" : "in contention";
    }
    row.appendChild(el("td", {}, statusText));
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderShowdownRejected(rejected) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(
    el("h2", { class: "pending-header" }, [
      "Pending fixes ",
      el("span", { class: "pending-count" }, `(${rejected.length})`),
    ]),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "pending-hint" },
      "These showdown submissions couldn't be matched. Resubmit using the " +
        "same display name (latest submission replaces the old one).",
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
    const list = el("ul", { class: "rejected-picks" });
    for (const e of r.errors || []) {
      list.appendChild(
        el("li", { class: "bad" }, [
          el("span", { class: "input" }, `${e.field}: ${e.input || "(empty)"}`),
          el("span", { class: "msg" }, e.message),
        ]),
      );
    }
    card.appendChild(list);
    wrap.appendChild(card);
  }
  return wrap;
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
    const fieldNameCell = el("td", { class: "player" });
    fieldNameCell.appendChild(playerNameLink(p));
    tbody.appendChild(
      el("tr", {}, [fieldNameCell, el("td", {}, p.country || "")]),
    );
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

// ---------- picker (custom selection page) ----------
// Uses native <input type="checkbox"> elements so the browser handles all
// the click/hover/focus state. We track selection in pickerSelected as an
// ordered list of ids — insertion order becomes Pick 1..Pick 6 in the form.
let pickerSelected = [];
let pickerPlayers = [];
let pickerFiltered = [];

function initPicker(players) {
  try {
    if (isPastCutoff()) {
      renderPickerClosed();
      return;
    }

    pickerPlayers = (players || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    pickerFiltered = pickerPlayers;

    const search = document.getElementById("picker-search");
    if (search) {
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        pickerFiltered = q
          ? pickerPlayers.filter(
              (p) =>
                (p.name || "").toLowerCase().includes(q) ||
                (p.country || "").toLowerCase().includes(q),
            )
          : pickerPlayers;
        drawPickerField();
      });
    }

    const submitBtn = document.getElementById("picker-submit");
    if (submitBtn) {
      submitBtn.addEventListener("click", handlePickerSubmit);
    }

    drawPickerField();
    updatePickerCount();
    renderDeadlineNote();
  } catch (e) {
    console.error("initPicker failed:", e);
    const root = document.getElementById("picker-field");
    if (root) {
      root.innerHTML =
        '<div class="empty">Picker failed to load: ' +
        (e && e.message ? e.message : "unknown error") +
        ". Use the fallback Google Form link below.</div>";
    }
  }
}

function renderPickerClosed() {
  const panel = document.getElementById("tab-pick");
  if (!panel) return;
  // Replace the entire picker UI with a "submissions closed" card so there's
  // no way to confuse the visitor into thinking the form might still accept
  // their entry.
  panel.innerHTML = "";
  const card = el("div", { class: "picker-closed" });
  card.appendChild(
    el("h2", { class: "picker-closed-title" }, "Submissions are closed"),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      `The deadline was ${formatCutoffLocal()}. New picks won't be counted.`,
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      "Head over to the Pool standings tab to see how everyone is doing.",
    ),
  );
  panel.appendChild(card);
}

function renderDeadlineNote() {
  // Add a small "deadline: ..." note above the green picks bar so visitors
  // know how much time they have left.
  const bar = document.getElementById("picker-count");
  if (!bar) return;
  let note = document.getElementById("picker-deadline-note");
  if (!note) {
    note = el("p", { id: "picker-deadline-note", class: "picker-deadline" });
    const barContainer = bar.closest(".picker-bar");
    if (barContainer && barContainer.parentNode) {
      barContainer.parentNode.insertBefore(note, barContainer);
    }
  }
  note.textContent = `Deadline: ${formatCutoffLocal()}`;
}

function drawPickerField() {
  const root = document.getElementById("picker-field");
  if (!root) return;
  root.innerHTML = "";

  if (!pickerPlayers.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "Field hasn't loaded yet. Try refreshing in a minute.",
      ),
    );
    return;
  }

  if (!pickerFiltered.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No players match that search."),
    );
    return;
  }

  const atMax = pickerSelected.length >= PICKS_REQUIRED;

  for (const p of pickerFiltered) {
    const id = String(p.id);
    const isChecked = pickerSelected.includes(id);

    const label = document.createElement("label");
    label.className = "picker-row" + (isChecked ? " checked" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "picker-checkbox";
    cb.value = id;
    cb.checked = isChecked;
    cb.disabled = atMax && !isChecked;
    cb.addEventListener("change", function () {
      handleCheckboxChange(id, cb);
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "picker-row-name";
    nameSpan.textContent = p.name || "—";

    label.appendChild(cb);
    const pickerAvatar = playerAvatar(p.id);
    if (pickerAvatar) label.appendChild(pickerAvatar);
    label.appendChild(nameSpan);

    if (p.country) {
      const countrySpan = document.createElement("span");
      countrySpan.className = "picker-row-country";
      countrySpan.textContent = p.country;
      label.appendChild(countrySpan);
    }

    root.appendChild(label);
  }
}

function handleCheckboxChange(id, cb) {
  if (cb.checked) {
    if (pickerSelected.length >= PICKS_REQUIRED) {
      cb.checked = false;
      flashPickerStatus(
        `You've already picked ${PICKS_REQUIRED}. Uncheck one before adding another.`,
        "error",
      );
      return;
    }
    pickerSelected.push(id);
  } else {
    const idx = pickerSelected.indexOf(id);
    if (idx >= 0) pickerSelected.splice(idx, 1);
  }
  updatePickerCount();
  // Redraw so other checkboxes pick up the right disabled state when we
  // cross the cap in either direction.
  drawPickerField();
}

function updatePickerCount() {
  const counter = document.getElementById("picker-count");
  if (counter) {
    counter.textContent = `${pickerSelected.length} / ${PICKS_REQUIRED} picked`;
  }
}

let pickerStatusTimer = null;
function flashPickerStatus(msg, kind) {
  const status = document.getElementById("picker-status");
  if (!status) return;
  status.textContent = msg;
  status.className = "picker-status visible " + (kind || "info");
  if (pickerStatusTimer) clearTimeout(pickerStatusTimer);
  pickerStatusTimer = setTimeout(() => {
    status.classList.remove("visible");
  }, 4500);
}

function handlePickerSubmit() {
  if (isPastCutoff()) {
    flashPickerStatus(
      `Submissions closed at ${formatCutoffLocal()}.`,
      "error",
    );
    return;
  }

  const nameEl = document.getElementById("picker-name");
  const name = (nameEl && nameEl.value.trim()) || "";

  if (!name) {
    flashPickerStatus("Enter a display name first.", "error");
    if (nameEl) nameEl.focus();
    return;
  }
  if (pickerSelected.length !== PICKS_REQUIRED) {
    flashPickerStatus(
      `Pick exactly ${PICKS_REQUIRED} golfers — you have ${pickerSelected.length}.`,
      "error",
    );
    return;
  }

  const byId = new Map(pickerPlayers.map((p) => [String(p.id), p]));
  const params = new URLSearchParams();
  params.set("usp", "pp_url");
  params.set(FORM_PREFILL.displayName, name);
  pickerSelected.forEach((id, i) => {
    const p = byId.get(id);
    params.set(FORM_PREFILL.picks[i], (p && p.name) || id);
  });

  const url = `${FORM_PREFILL.base}?${params.toString()}`;
  window.open(url, "_blank", "noopener");
  flashPickerStatus(
    "Form opened in a new tab — click Submit on the form to finalize.",
    "success",
  );
}

// ---------- showdown picker ----------
// Independent state from the main picker so the two pickers don't fight over
// each other's selections. Picker is a one-time DOM build (initShowdownPicker
// is called once in main); the standings/explainer block above it is the
// only thing that re-renders on data refresh.

let showdownPick3Selected = []; // ordered list of golfer ids (max 3)
let showdownChampionId = null;
let showdownBoomHolesId = null;
let showdownPlayers = []; // cut survivors, sorted by leaderboard position
let showdownFiltered = [];
let showdownStatusTimer = null;

function initShowdownPicker(players) {
  const root = document.getElementById("showdown-picker");
  if (!root) return;
  root.innerHTML = "";

  if (isShowdownPastCutoff()) {
    root.appendChild(renderShowdownPickerClosed());
    return;
  }
  if (!isShowdownConfigured()) {
    root.appendChild(renderShowdownPickerNotConfigured());
    return;
  }

  // Cut survivors only, sorted by leaderboard position (lowest scoreToPar
  // first). This is intentionally different from the main picker, which
  // alphabetizes — here, the leaders are at the top so they're easy to find.
  showdownPlayers = (players || [])
    .filter(
      (p) =>
        p.status !== "cut" &&
        p.status !== "wd" &&
        p.status !== "dq" &&
        p.status !== "dns",
    )
    .slice()
    .sort((a, b) => {
      const sa = a.scoreToPar == null ? 999 : a.scoreToPar;
      const sb = b.scoreToPar == null ? 999 : b.scoreToPar;
      if (sa !== sb) return sa - sb;
      return (a.name || "").localeCompare(b.name || "");
    });
  showdownFiltered = showdownPlayers;

  if (!showdownPlayers.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "No cut-survivors in the field yet. The showdown picker opens after the Friday cut.",
      ),
    );
    return;
  }

  buildShowdownPickerDOM(root);
}

function renderShowdownPickerClosed() {
  const card = el("div", { class: "picker-closed" });
  card.appendChild(
    el(
      "h2",
      { class: "picker-closed-title" },
      "Showdown submissions are closed",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      `The deadline was ${formatShowdownCutoffLocal()}. New picks won't count.`,
    ),
  );
  return card;
}

function renderShowdownPickerNotConfigured() {
  const card = el("div", { class: "picker-closed" });
  card.appendChild(
    el(
      "h2",
      { class: "picker-closed-title" },
      "Showdown form not yet configured",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      "The Sunday Showdown picker will appear here once the secondary " +
        "Google Form has been created and SHOWDOWN_FORM_PREFILL is filled " +
        "in inside assets/app.js. See the README for setup steps.",
    ),
  );
  return card;
}

function buildShowdownPickerDOM(root) {
  // Header card
  const header = el("div", { class: "showdown-picker-header" });
  header.appendChild(el("h2", {}, "Make your Sunday Showdown picks"));
  header.appendChild(
    el(
      "p",
      { class: "hint" },
      `Three contests on one form. Deadline: ${formatShowdownCutoffLocal()}.`,
    ),
  );
  root.appendChild(header);

  // Display name
  const nameWrap = el("div", { class: "picker-form" });
  nameWrap.appendChild(
    el(
      "label",
      { class: "picker-label", for: "showdown-name" },
      "Your display name",
    ),
  );
  const nameInput = document.createElement("input");
  nameInput.id = "showdown-name";
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Pat M.";
  nameInput.autocomplete = "off";
  nameInput.maxLength = 40;
  nameWrap.appendChild(nameInput);
  root.appendChild(nameWrap);

  // ===== PICK 3 section =====
  const pick3Section = el("section", { class: "showdown-picker-section" });
  pick3Section.appendChild(
    el("h3", {}, `Pick 3 — choose ${PICK3_REQUIRED} golfers`),
  );
  pick3Section.appendChild(
    el(
      "p",
      { class: "hint" },
      "Sum of all 3 R4 to-pars. No drops. Lowest wins.",
    ),
  );

  const pickerBar = el("div", { class: "picker-bar" });
  const counter = el(
    "span",
    { id: "showdown-pick3-count", class: "picker-count" },
    `0 / ${PICK3_REQUIRED} picked`,
  );
  pickerBar.appendChild(counter);
  pick3Section.appendChild(pickerBar);

  const search = document.createElement("input");
  search.id = "showdown-pick3-search";
  search.type = "search";
  search.placeholder = "Search the field…";
  search.autocomplete = "off";
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    showdownFiltered = q
      ? showdownPlayers.filter(
          (p) =>
            (p.name || "").toLowerCase().includes(q) ||
            (p.country || "").toLowerCase().includes(q),
        )
      : showdownPlayers;
    drawShowdownPick3Field();
  });
  pick3Section.appendChild(search);

  const grid = el("div", {
    id: "showdown-pick3-field",
    class: "picker-field",
  });
  pick3Section.appendChild(grid);
  root.appendChild(pick3Section);

  // ===== CHAMPION CALL section =====
  const champSection = el("section", { class: "showdown-picker-section" });
  champSection.appendChild(el("h3", {}, "Champion Call"));
  champSection.appendChild(
    el(
      "p",
      { class: "hint" },
      "Pick the outright winner + a winning to-par guess.",
    ),
  );

  const champLabel = el(
    "label",
    { class: "picker-label", for: "showdown-champion" },
    "Champion",
  );
  champSection.appendChild(champLabel);
  const champSelect = document.createElement("select");
  champSelect.id = "showdown-champion";
  champSelect.className = "showdown-select";
  populateGolferSelect(champSelect, "(choose a golfer)");
  champSelect.addEventListener("change", () => {
    showdownChampionId = champSelect.value || null;
  });
  champSection.appendChild(champSelect);

  const guessLabel = el(
    "label",
    { class: "picker-label", for: "showdown-guess" },
    "Predicted winning to-par (e.g. -12)",
  );
  champSection.appendChild(guessLabel);
  const guessInput = document.createElement("input");
  guessInput.id = "showdown-guess";
  guessInput.type = "number";
  guessInput.step = "1";
  guessInput.min = "-30";
  guessInput.max = "20";
  guessInput.placeholder = "-10";
  guessInput.className = "showdown-number";
  champSection.appendChild(guessInput);
  root.appendChild(champSection);

  // ===== BOOM HOLES section =====
  const boomSection = el("section", { class: "showdown-picker-section" });
  boomSection.appendChild(el("h3", {}, "Boom Holes"));
  boomSection.appendChild(
    el(
      "p",
      { class: "hint" },
      `One golfer, sum of strokes-to-par on holes ${BOOM_HOLES.join(", ")}. Lowest wins.`,
    ),
  );

  const boomLabel = el(
    "label",
    { class: "picker-label", for: "showdown-boom" },
    "Boom Holes pick",
  );
  boomSection.appendChild(boomLabel);
  const boomSelect = document.createElement("select");
  boomSelect.id = "showdown-boom";
  boomSelect.className = "showdown-select";
  populateGolferSelect(boomSelect, "(choose a golfer)");
  boomSelect.addEventListener("change", () => {
    showdownBoomHolesId = boomSelect.value || null;
  });
  boomSection.appendChild(boomSelect);
  root.appendChild(boomSection);

  // Submit + status
  const submitBar = el("div", { class: "picker-bar" });
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "picker-submit";
  submitBtn.textContent = "Submit showdown picks";
  submitBtn.addEventListener("click", handleShowdownSubmit);
  submitBar.appendChild(submitBtn);
  root.appendChild(submitBar);

  const status = el(
    "p",
    { id: "showdown-status", class: "picker-status" },
    "",
  );
  root.appendChild(status);

  drawShowdownPick3Field();
}

function populateGolferSelect(select, placeholder) {
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = placeholder;
  select.appendChild(blank);
  for (const p of showdownPlayers) {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    const score = p.scoreToPar != null ? ` (${fmtToPar(p.scoreToPar)})` : "";
    opt.textContent = `${p.name}${score}`;
    select.appendChild(opt);
  }
}

function drawShowdownPick3Field() {
  const root = document.getElementById("showdown-pick3-field");
  if (!root) return;
  root.innerHTML = "";

  if (!showdownFiltered.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No players match that search."),
    );
    return;
  }

  const atMax = showdownPick3Selected.length >= PICK3_REQUIRED;
  for (const p of showdownFiltered) {
    const id = String(p.id);
    const isChecked = showdownPick3Selected.includes(id);
    const label = document.createElement("label");
    label.className = "picker-row" + (isChecked ? " checked" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "picker-checkbox";
    cb.value = id;
    cb.checked = isChecked;
    cb.disabled = atMax && !isChecked;
    cb.addEventListener("change", () => handleShowdownCheckbox(id, cb));

    const nameSpan = document.createElement("span");
    nameSpan.className = "picker-row-name";
    nameSpan.textContent = p.name || "—";

    label.appendChild(cb);
    const av = playerAvatar(p.id);
    if (av) label.appendChild(av);
    label.appendChild(nameSpan);

    if (p.scoreToPar != null) {
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "picker-row-country";
      scoreSpan.textContent = fmtToPar(p.scoreToPar);
      label.appendChild(scoreSpan);
    }
    root.appendChild(label);
  }
}

function handleShowdownCheckbox(id, cb) {
  if (cb.checked) {
    if (showdownPick3Selected.length >= PICK3_REQUIRED) {
      cb.checked = false;
      flashShowdownStatus(
        `You've already picked ${PICK3_REQUIRED}. Uncheck one before adding another.`,
        "error",
      );
      return;
    }
    showdownPick3Selected.push(id);
  } else {
    const idx = showdownPick3Selected.indexOf(id);
    if (idx >= 0) showdownPick3Selected.splice(idx, 1);
  }
  updateShowdownCount();
  drawShowdownPick3Field();
}

function updateShowdownCount() {
  const counter = document.getElementById("showdown-pick3-count");
  if (counter) {
    counter.textContent = `${showdownPick3Selected.length} / ${PICK3_REQUIRED} picked`;
  }
}

function flashShowdownStatus(msg, kind) {
  const status = document.getElementById("showdown-status");
  if (!status) return;
  status.textContent = msg;
  status.className = "picker-status visible " + (kind || "info");
  if (showdownStatusTimer) clearTimeout(showdownStatusTimer);
  showdownStatusTimer = setTimeout(() => {
    status.classList.remove("visible");
  }, 5000);
}

function handleShowdownSubmit() {
  if (isShowdownPastCutoff()) {
    flashShowdownStatus(
      `Submissions closed at ${formatShowdownCutoffLocal()}.`,
      "error",
    );
    return;
  }

  const nameEl = document.getElementById("showdown-name");
  const name = (nameEl && nameEl.value.trim()) || "";
  const guessEl = document.getElementById("showdown-guess");
  const guess = (guessEl && guessEl.value.trim()) || "";

  if (!name) {
    flashShowdownStatus("Enter a display name first.", "error");
    if (nameEl) nameEl.focus();
    return;
  }
  if (showdownPick3Selected.length !== PICK3_REQUIRED) {
    flashShowdownStatus(
      `Pick exactly ${PICK3_REQUIRED} golfers — you have ${showdownPick3Selected.length}.`,
      "error",
    );
    return;
  }
  if (!showdownChampionId) {
    flashShowdownStatus("Pick your Champion Call winner.", "error");
    return;
  }
  if (!guess) {
    flashShowdownStatus(
      "Enter a winning to-par guess for Champion Call.",
      "error",
    );
    if (guessEl) guessEl.focus();
    return;
  }
  if (!showdownBoomHolesId) {
    flashShowdownStatus("Pick your Boom Holes golfer.", "error");
    return;
  }

  const byId = new Map(showdownPlayers.map((p) => [String(p.id), p]));
  const params = new URLSearchParams();
  params.set("usp", "pp_url");
  params.set(SHOWDOWN_FORM_PREFILL.displayName, name);
  showdownPick3Selected.forEach((id, i) => {
    const p = byId.get(id);
    params.set(SHOWDOWN_FORM_PREFILL.pick3[i], (p && p.name) || id);
  });
  const champPlayer = byId.get(showdownChampionId);
  params.set(
    SHOWDOWN_FORM_PREFILL.champion,
    (champPlayer && champPlayer.name) || showdownChampionId,
  );
  params.set(SHOWDOWN_FORM_PREFILL.championGuess, guess);
  const boomPlayer = byId.get(showdownBoomHolesId);
  params.set(
    SHOWDOWN_FORM_PREFILL.boomHoles,
    (boomPlayer && boomPlayer.name) || showdownBoomHolesId,
  );

  const url = `${SHOWDOWN_FORM_PREFILL.base}?${params.toString()}`;
  window.open(url, "_blank", "noopener");
  flashShowdownStatus(
    "Form opened in a new tab — click Submit on the form to finalize.",
    "success",
  );
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
  // Detect repo from the current GitHub Pages URL so the footer link works
  // wherever this site is deployed.
  const host = location.hostname;
  const path = location.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (host.endsWith(".github.io")) {
    const owner = host.split(".")[0];
    const repo = path[0] || `${owner}.github.io`;
    document.getElementById("repo-link").href =
      `https://github.com/${owner}/${repo}`;
  } else {
    document.getElementById("repo-link").href = "https://github.com";
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

  let scores, entriesData, showdownData;
  try {
    [scores, entriesData, showdownData] = await Promise.all([
      loadJson("data/scores.json"),
      loadJson("data/entries.json").catch(() => ({ entries: [] })),
      loadJson("data/showdown.json").catch(() => ({ entries: [], rejected: [] })),
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
  currentEventId = (scores.tournament && scores.tournament.id) || currentEventId;

  renderHeader(scores.tournament);
  renderPoolStandings(entriesData.entries || [], byId);
  renderRejected(entriesData.rejected || []);
  renderLeaderboard(players);
  renderField(players);
  initPicker(players);
  renderShowdown(showdownData, players, byId, scores.tournament);
  initShowdownPicker(players);
}

main();
