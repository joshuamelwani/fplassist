"use strict";

/* =========================================================================
   Squad Room — client app
   Reads pre-computed data/players.json and data/recommended_squad.json
   (produced weekly by the GitHub Actions pipeline). Everything below runs
   client-side: no server, no build step.
   ========================================================================= */

const BUDGET = 100.0;
const POS_ORDER = ["GKP", "DEF", "MID", "FWD"];
const POS_QUOTA = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const LS_TEAM_KEY = "squadRoom.myTeam.v1";
const LS_FT_KEY = "squadRoom.freeTransfers.v1";

let DATA = null;          // full players.json payload
let PLAYERS_BY_ID = {};   // id -> player
let TEAM_FIXTURES = {};   // team_id -> fixtures array (from any player on that team)
let RECOMMENDED = null;   // recommended_squad.json payload

let squadState = null;    // { players: [ {..player, isStarting, isCaptain, isVice} ], mode: 'optimal'|'manual' }

/* ---------------------------- data loading ---------------------------- */

async function loadData() {
  const [playersRes, recRes] = await Promise.allSettled([
    fetch("data/players.json", { cache: "no-store" }),
    fetch("data/recommended_squad.json", { cache: "no-store" }),
  ]);

  if (playersRes.status !== "fulfilled" || !playersRes.value.ok) {
    showDataMissing();
    return false;
  }
  DATA = await playersRes.value.json();
  DATA.players.forEach((p) => (PLAYERS_BY_ID[p.id] = p));

  DATA.players.forEach((p) => {
    if (!TEAM_FIXTURES[p.team_id] && p.fixtures && p.fixtures.length) {
      TEAM_FIXTURES[p.team_id] = { team: p.team, fixtures: p.fixtures };
    }
  });

  if (recRes.status === "fulfilled" && recRes.value.ok) {
    RECOMMENDED = await recRes.value.json();
  }

  document.getElementById("gwPill").textContent = `GW ${DATA.next_event ?? "—"}`;
  return true;
}

function showDataMissing() {
  document.querySelector("main").innerHTML = `
    <div class="empty-state">
      <div class="section-title" style="justify-content:center;">No data yet</div>
      <p>This deployment hasn't pulled FPL data yet.</p>
      <p class="card-sub">In your GitHub repo, open the <strong>Actions</strong> tab → "Refresh FPL data" → Run workflow.
      It fetches the latest player data, computes forecasts, and publishes this site automatically. After that,
      it keeps itself updated on the weekly schedule.</p>
    </div>`;
}

/* ------------------------------ utilities ------------------------------ */

function fmtM(n) { return `£${n.toFixed(1)}m`; }

function squadCost(players) { return players.reduce((s, p) => s + p.cost, 0); }

function teamCounts(players) {
  const c = {};
  players.forEach((p) => (c[p.team_id] = (c[p.team_id] || 0) + 1));
  return c;
}

function emptySquadState(mode) {
  return { mode, players: [] };
}

/* -------------------------- squad state helpers ------------------------- */

function toStateFromOptimizerResult(result) {
  const players = [];
  result.starting_xi.forEach((p) =>
    players.push({ ...p, isStarting: true, isCaptain: p.id === result.captain_id, isVice: p.id === result.vice_captain_id })
  );
  result.bench.forEach((p) => players.push({ ...p, isStarting: false, isCaptain: false, isVice: false }));
  return { mode: "optimal", players };
}

function validFormationCounts(players) {
  const starters = players.filter((p) => p.isStarting);
  const c = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  starters.forEach((p) => (c[p.pos] += 1));
  return c;
}

function formationIsLegal(c) {
  return c.GKP === 1 && c.DEF >= 3 && c.DEF <= 5 && c.MID >= 2 && c.MID <= 5 && c.FWD >= 1 && c.FWD <= 3
    && (c.GKP + c.DEF + c.MID + c.FWD === 11);
}

/* ------------------------------ rendering ------------------------------- */

function jerseyHTML(p) {
  const flag = p.status !== "a" ? " flagged" : "";
  const cap = p.isCaptain ? " captain" : (p.isVice ? " vice" : "");
  return `
    <div class="player-card" data-pid="${p.id}">
      <div class="jersey${cap}${flag}">${p.pos}</div>
      <div class="p-name">${p.name}</div>
      <div class="p-meta">${fmtM(p.cost)} · ${p.xP_next.toFixed(1)}xP</div>
    </div>`;
}

function renderPitch(state) {
  const startWrap = document.getElementById("pitchStarting");
  const benchWrap = document.getElementById("pitchBench");
  const starters = state.players.filter((p) => p.isStarting);
  const bench = state.players.filter((p) => !p.isStarting);

  if (!state.players.length) {
    startWrap.innerHTML = `<div class="empty-state" style="color:rgba(244,246,242,0.8);">Tap "Build my own" or pick a slot below to start your squad.</div>`;
    benchWrap.innerHTML = "";
    return;
  }

  let rows = "";
  POS_ORDER.forEach((pos) => {
    const inPos = starters.filter((p) => p.pos === pos);
    if (inPos.length) rows += `<div class="pitch-row">${inPos.map(jerseyHTML).join("")}</div>`;
  });
  startWrap.innerHTML = rows;
  benchWrap.innerHTML = bench.map(jerseyHTML).join("");

  // click handling
  startWrap.querySelectorAll(".player-card").forEach((el) => el.addEventListener("click", () => onPlayerCardTap(parseInt(el.dataset.pid), true)));
  benchWrap.querySelectorAll(".player-card").forEach((el) => el.addEventListener("click", () => onPlayerCardTap(parseInt(el.dataset.pid), false)));
}

function renderSquadSummary(state) {
  const card = document.getElementById("squadSummaryCard");
  const cost = squadCost(state.players);
  const left = BUDGET - cost;
  document.getElementById("statBudget").textContent = fmtM(left);
  document.getElementById("statBudget").className = "value" + (left < 0 ? " over" : left > 0 ? "" : " good");
  document.getElementById("statSquadCount").textContent = `${state.players.length}/15`;

  const c = validFormationCounts(state.players);
  const legal = state.players.length < 15 ? null : formationIsLegal(c);
  const projected = state.players
    .filter((p) => p.isStarting)
    .reduce((s, p) => s + p.xP_next + (p.isCaptain ? p.xP_next : 0), 0);

  card.innerHTML = `
    <div class="card-title">Formation ${c.DEF}-${c.MID}-${c.FWD}
      ${legal === false ? '<span style="color:var(--red); font-weight:600; font-size:12px;"> · invalid</span>' : ""}
    </div>
    <div class="card-sub">Squad cost ${fmtM(cost)} of ${fmtM(BUDGET)} · Projected next GW: <strong style="color:var(--amber);">${projected.toFixed(1)} pts</strong></div>
  `;

  document.getElementById("lockSquadBtn").disabled = state.players.length !== 15 || !legal;
}

function onPlayerCardTap(pid, isStarting) {
  if (squadState.mode === "optimal") {
    openPlayerDetail(pid);
    return;
  }
  // manual mode: open action sheet
  openManualActionSheet(pid);
}

/* --------------------------- squad tab wiring --------------------------- */

function initSquadTab() {
  document.querySelectorAll("#squadModeToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#squadModeToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setSquadMode(btn.dataset.mode);
    });
  });

  document.getElementById("resetSquadBtn").addEventListener("click", () => {
    if (squadState.mode === "optimal") {
      squadState = toStateFromOptimizerResult(RECOMMENDED.recommended_5gw_horizon);
    } else {
      squadState = emptySquadState("manual");
    }
    renderSquadTab();
  });

  document.getElementById("lockSquadBtn").addEventListener("click", () => {
    localStorage.setItem(LS_TEAM_KEY, JSON.stringify({ savedForEvent: DATA.next_event, players: squadState.players }));
    document.getElementById("squadNotice").innerHTML = `<div class="notice">Saved. Head to the Transfers tab each week to get swap suggestions for this squad.</div>`;
  });

  setSquadMode("optimal");
}

function setSquadMode(mode) {
  document.getElementById("squadHorizonLabel").textContent = mode === "optimal" ? "Optimizer's Starting XI (next 5 GW horizon)" : "Starting XI";
  if (mode === "optimal") {
    if (!RECOMMENDED) {
      document.getElementById("squadNotice").innerHTML = `<div class="notice warn">No optimizer output found yet — showing manual builder instead.</div>`;
      squadState = emptySquadState("manual");
    } else {
      squadState = toStateFromOptimizerResult(RECOMMENDED.recommended_5gw_horizon);
      document.getElementById("squadNotice").innerHTML = "";
    }
  } else {
    squadState = emptySquadState("manual");
    document.getElementById("squadNotice").innerHTML = `<div class="notice">Tap a shirt slot below to fill it. Budget and the 3-per-club rule are enforced as you go.</div>`;
  }
  renderSquadTab();
}

function renderSquadTab() {
  renderPitch(squadState);
  renderSquadSummary(squadState);
  renderManualSlotList();
}

/* --------------------------- manual squad build -------------------------- */

function renderManualSlotList() {
  let host = document.getElementById("manualSlotList");
  if (squadState.mode !== "manual") {
    if (host) host.remove();
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.id = "manualSlotList";
    document.getElementById("squadSummaryCard").insertAdjacentElement("afterend", host);
  }

  let html = `<div class="section-title">Your 15</div>`;
  POS_ORDER.forEach((pos) => {
    const filled = squadState.players.filter((p) => p.pos === pos);
    const quota = POS_QUOTA[pos];
    html += `<div class="card"><div class="card-title">${pos}</div><div class="filter-row" style="margin-top:8px; flex-wrap:wrap;">`;
    for (let i = 0; i < quota; i++) {
      const p = filled[i];
      if (p) {
        html += `<button class="chip-toggle active" data-action="edit" data-pid="${p.id}">${p.name} · ${fmtM(p.cost)}</button>`;
      } else {
        html += `<button class="chip-toggle" data-action="add" data-pos="${pos}">+ Add ${pos}</button>`;
      }
    }
    html += `</div></div>`;
  });
  host.innerHTML = html;

  host.querySelectorAll('[data-action="add"]').forEach((btn) =>
    btn.addEventListener("click", () => openPlayerPicker(btn.dataset.pos, null))
  );
  host.querySelectorAll('[data-action="edit"]').forEach((btn) =>
    btn.addEventListener("click", () => openManualActionSheet(parseInt(btn.dataset.pid)))
  );
}

function openPlayerPicker(pos, replacingId) {
  const budgetLeft = BUDGET - squadCost(squadState.players) + (replacingId ? PLAYERS_BY_ID[replacingId].cost : 0);
  const counts = teamCounts(squadState.players.filter((p) => p.id !== replacingId));
  const existingIds = new Set(squadState.players.filter((p) => p.id !== replacingId).map((p) => p.id));

  const candidates = DATA.players
    .filter((p) => p.pos === pos)
    .filter((p) => !existingIds.has(p.id))
    .filter((p) => p.cost <= budgetLeft + 1e-6)
    .filter((p) => (counts[p.team_id] || 0) < 3)
    .sort((a, b) => b.xP_5gw - a.xP_5gw);

  const rowsHtml = candidates.slice(0, 60).map((p) => `
    <div class="player-row" data-pid="${p.id}">
      <div class="pr-pos ${p.pos}">${p.pos}</div>
      <div class="pr-main">
        <div class="pr-name">${p.name} <span class="pr-sub">${p.team}</span></div>
        <div class="pr-sub">${p.status !== "a" ? "⚠ " + (p.news || "Fitness doubt") : "Next 5: " + p.xP_5gw.toFixed(1) + " xP"}</div>
      </div>
      <div class="pr-stats">
        <div class="pr-xp">${p.xP_next.toFixed(1)}</div>
        <div class="pr-cost">${fmtM(p.cost)}</div>
      </div>
    </div>`).join("");

  showModal(`
    <div class="close-row">
      <div class="card-title">Pick ${pos} · budget ${fmtM(budgetLeft)} left</div>
      <button class="btn small ghost" id="modalCloseBtn">Close</button>
    </div>
    ${candidates.length === 0 ? '<div class="empty-state">No affordable options left for this slot.</div>' : rowsHtml}
  `);

  document.querySelectorAll("#modalRoot .player-row").forEach((row) =>
    row.addEventListener("click", () => {
      const pid = parseInt(row.dataset.pid);
      addOrReplacePlayer(pid, replacingId);
      closeModal();
    })
  );
}

function addOrReplacePlayer(pid, replacingId) {
  const player = { ...PLAYERS_BY_ID[pid], isStarting: false, isCaptain: false, isVice: false };
  if (replacingId) {
    squadState.players = squadState.players.filter((p) => p.id !== replacingId);
  }
  squadState.players.push(player);
  autoAssignStarting();
  renderSquadTab();
}

function autoAssignStarting() {
  // Whenever the 15 changes, try to keep a legal XI: prefer previously
  // starting players, fill gaps with the highest-xP available at each pos.
  const bySlotPriority = ["GKP", "DEF", "MID", "FWD"];
  const squad = squadState.players;
  squad.forEach((p) => { if (p.isStarting === undefined) p.isStarting = false; });

  if (squad.length < 11) {
    squad.forEach((p) => (p.isStarting = squad.length <= 11));
    return;
  }
  // simple default: 1 GK, 4 DEF, 4 MID, 2 FWD adjusted to what's available
  const target = { GKP: 1, DEF: Math.min(4, squad.filter(p=>p.pos==="DEF").length), MID: Math.min(4, squad.filter(p=>p.pos==="MID").length), FWD: Math.min(2, squad.filter(p=>p.pos==="FWD").length) };
  let total = target.GKP + target.DEF + target.MID + target.FWD;
  while (total < 11) {
    for (const pos of ["MID", "DEF", "FWD"]) {
      const available = squad.filter((p) => p.pos === pos).length;
      if (target[pos] < available && total < 11) { target[pos]++; total++; }
      if (total >= 11) break;
    }
    if (total < 11) break; // can't reach 11 yet (squad incomplete)
  }
  bySlotPriority.forEach((pos) => {
    const players = squad.filter((p) => p.pos === pos).sort((a, b) => b.xP_next - a.xP_next);
    players.forEach((p, i) => (p.isStarting = i < target[pos]));
  });
  if (!squad.some((p) => p.isCaptain) ) {
    const best = [...squad].filter(p=>p.isStarting).sort((a, b) => b.xP_next - a.xP_next)[0];
    if (best) best.isCaptain = true;
  }
  if (!squad.some((p) => p.isVice)) {
    const starters = squad.filter((p) => p.isStarting && !p.isCaptain).sort((a, b) => b.xP_next - a.xP_next);
    if (starters[0]) starters[0].isVice = true;
  }
}

function openManualActionSheet(pid) {
  const p = squadState.players.find((x) => x.id === pid);
  if (!p) return;
  showModal(`
    <div class="close-row">
      <div class="card-title">${p.name} <span class="card-sub">${p.team} · ${fmtM(p.cost)}</span></div>
      <button class="btn small ghost" id="modalCloseBtn">Close</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:8px;">
      ${p.isStarting ? '<button class="btn" id="actBench">Move to bench</button>' : '<button class="btn" id="actStart">Move to starting XI</button>'}
      ${p.isStarting ? '<button class="btn" id="actCaptain">Make captain</button>' : ""}
      ${p.isStarting && !p.isCaptain ? '<button class="btn" id="actVice">Make vice-captain</button>' : ""}
      <button class="btn" id="actReplace">Replace player</button>
      <button class="btn ghost" id="actRemove" style="color:var(--red); border-color:var(--red);">Remove from squad</button>
    </div>
  `);

  const q = (id) => document.getElementById(id);
  if (q("actBench")) q("actBench").addEventListener("click", () => { toggleStart(pid, false); closeModal(); });
  if (q("actStart")) q("actStart").addEventListener("click", () => { toggleStart(pid, true); closeModal(); });
  if (q("actCaptain")) q("actCaptain").addEventListener("click", () => { setCaptain(pid); closeModal(); });
  if (q("actVice")) q("actVice").addEventListener("click", () => { setVice(pid); closeModal(); });
  if (q("actReplace")) q("actReplace").addEventListener("click", () => { closeModal(); openPlayerPicker(p.pos, pid); });
  if (q("actRemove")) q("actRemove").addEventListener("click", () => {
    squadState.players = squadState.players.filter((x) => x.id !== pid);
    closeModal(); renderSquadTab();
  });
}

function toggleStart(pid, toStarting) {
  const p = squadState.players.find((x) => x.id === pid);
  const c = validFormationCounts(squadState.players);
  if (toStarting) {
    if (c[p.pos] >= (p.pos === "GKP" ? 1 : p.pos === "DEF" ? 5 : p.pos === "MID" ? 5 : 3)) {
      // bench a same-position starter with the lowest xP to make room
      const swap = squadState.players.filter((x) => x.pos === p.pos && x.isStarting).sort((a, b) => a.xP_next - b.xP_next)[0];
      if (swap) swap.isStarting = false;
    }
    p.isStarting = true;
  } else {
    p.isStarting = false;
    if (p.isCaptain || p.isVice) { p.isCaptain = false; p.isVice = false; }
  }
  renderSquadTab();
}

function setCaptain(pid) {
  squadState.players.forEach((p) => (p.isCaptain = p.id === pid));
  const cap = squadState.players.find((p) => p.id === pid);
  const vice = squadState.players.find((p) => p.isVice);
  if (vice && vice.id === pid) vice.isVice = false;
  renderSquadTab();
}
function setVice(pid) {
  squadState.players.forEach((p) => (p.isVice = p.id === pid && !p.isCaptain));
  renderSquadTab();
}

/* --------------------------------- modal --------------------------------- */

function showModal(innerHtml) {
  document.getElementById("modalRoot").innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">${innerHtml}</div>
    </div>`;
  document.getElementById("modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") closeModal();
  });
  const closeBtn = document.getElementById("modalCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
}
function closeModal() { document.getElementById("modalRoot").innerHTML = ""; }

function openPlayerDetail(pid) {
  const p = PLAYERS_BY_ID[pid];
  if (!p) return;
  const fixHtml = p.fixtures.map((f) => {
    const opp = f.opponents.map((o) => `${o.home ? "" : "@"}${o.opp}`).join(", ");
    const fdr = f.opponents[0]?.fdr ?? 3;
    return `<div class="fdr-row"><span class="fdr-team">GW${f.event}</span><div class="fdr-cells"><span class="fdr-cell fdr-${fdr}">${opp}</span></div><span class="pr-cost">${f.xP.toFixed(1)} xP</span></div>`;
  }).join("");
  showModal(`
    <div class="close-row">
      <div class="card-title">${p.full_name} <span class="card-sub">${p.team} · ${p.pos} · ${fmtM(p.cost)}</span></div>
      <button class="btn small ghost" id="modalCloseBtn">Close</button>
    </div>
    ${p.status !== "a" ? `<div class="notice warn">${p.news || "Fitness doubt"}</div>` : ""}
    <div class="card" style="display:flex; justify-content:space-around; text-align:center;">
      <div><div class="pr-xp">${p.xP_next.toFixed(1)}</div><div class="pr-cost">Next GW</div></div>
      <div><div class="pr-xp">${p.xP_3gw.toFixed(1)}</div><div class="pr-cost">Next 3</div></div>
      <div><div class="pr-xp">${p.xP_5gw.toFixed(1)}</div><div class="pr-cost">Next 5</div></div>
      <div><div class="pr-xp">${p.value_next.toFixed(2)}</div><div class="pr-cost">xP/£m</div></div>
    </div>
    <div class="section-title">Fixtures</div>
    ${fixHtml || '<p class="card-sub">No fixtures found in the current data window.</p>'}
  `);
}

/* ------------------------------ players tab ------------------------------ */

function initPlayersTab() {
  document.getElementById("playerSearch").addEventListener("input", renderPlayerList);
  document.querySelectorAll("#posFilterRow .chip-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("#posFilterRow .chip-toggle").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderPlayerList();
    })
  );
  document.querySelectorAll("#sortToggle button").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("#sortToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderPlayerList();
    })
  );
  renderPlayerList();
}

function renderPlayerList() {
  const list = document.getElementById("playerList");
  if (!DATA) return;
  const pos = document.querySelector("#posFilterRow .chip-toggle.active")?.dataset.pos || "ALL";
  const sortKey = document.querySelector("#sortToggle button.active")?.dataset.sort || "xP_next";
  const q = document.getElementById("playerSearch").value.trim().toLowerCase();

  let players = DATA.players.filter((p) => pos === "ALL" || p.pos === pos);
  if (q) players = players.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  players = players.slice().sort((a, b) => b[sortKey] - a[sortKey]);

  list.innerHTML = players.slice(0, 100).map((p) => `
    <div class="player-row" data-pid="${p.id}">
      <div class="pr-pos ${p.pos}">${p.pos}</div>
      <div class="pr-main">
        <div class="pr-name">${p.name}${p.status !== "a" ? " ⚠" : ""}</div>
        <div class="pr-sub">${p.team} · ${fmtM(p.cost)}${p.blank_next ? " · blank next GW" : ""}</div>
      </div>
      <div class="pr-stats">
        <div class="pr-xp">${p[sortKey].toFixed(2)}</div>
        <div class="pr-cost">${sortKey === "value_next" ? "xP/£m" : "xP"}</div>
      </div>
    </div>`).join("") || '<div class="empty-state">No players match.</div>';

  list.querySelectorAll(".player-row").forEach((row) => row.addEventListener("click", () => openPlayerDetail(parseInt(row.dataset.pid))));
}

/* ----------------------------- fixtures tab ------------------------------ */

function renderFixturesTab() {
  const grid = document.getElementById("fdrGrid");
  const teams = Object.values(TEAM_FIXTURES).sort((a, b) => a.team.localeCompare(b.team));
  grid.innerHTML = teams.map(({ team, fixtures }) => {
    const cells = fixtures.slice(0, 5).map((f) => {
      const o = f.opponents[0];
      if (!o) return `<span class="fdr-cell fdr-3">—</span>`;
      return `<span class="fdr-cell fdr-${o.fdr}">${o.home ? "" : "@"}${o.opp}</span>`;
    }).join("");
    return `<div class="fdr-row"><span class="fdr-team">${team}</span><div class="fdr-cells">${cells}</div></div>`;
  }).join("");
}

/* ----------------------------- transfers tab ------------------------------ */

function loadMyTeam() {
  const raw = localStorage.getItem(LS_TEAM_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function renderTransfersTab() {
  const host = document.getElementById("transfersContent");
  const saved = loadMyTeam();

  if (!saved) {
    host.innerHTML = `
      <div class="empty-state">
        <div class="section-title" style="justify-content:center;">No saved team yet</div>
        <p>Build your squad in the Squad tab, then tap "Save as my team" to unlock weekly transfer suggestions here.</p>
      </div>`;
    return;
  }

  const current = saved.players.map((p) => ({ ...PLAYERS_BY_ID[p.id], isStarting: p.isStarting, isCaptain: p.isCaptain, isVice: p.isVice }));
  const ft = parseInt(localStorage.getItem(LS_FT_KEY) || "1", 10);

  host.innerHTML = `
    <div class="section-title">Free transfers available</div>
    <div class="seg-control" id="ftToggle" style="margin-bottom:16px;">
      <button data-ft="1" class="${ft === 1 ? "active" : ""}">1</button>
      <button data-ft="2" class="${ft === 2 ? "active" : ""}">2 (rolled over)</button>
    </div>
    <div class="section-title">Your current squad</div>
    <div class="pitch-wrap" style="margin-bottom:16px;">
      <div class="pitch" id="myPitchStarting"></div>
      <div class="bench-strip" id="myPitchBench"></div>
    </div>
    <div class="section-title">Suggested transfers <span class="card-sub" style="text-transform:none; letter-spacing:0;">ranked by 3-GW gain</span></div>
    <div id="transferSuggestions"></div>
  `;

  document.querySelectorAll("#ftToggle button").forEach((btn) =>
    btn.addEventListener("click", () => {
      localStorage.setItem(LS_FT_KEY, btn.dataset.ft);
      renderTransfersTab();
    })
  );

  const startWrap = document.getElementById("myPitchStarting");
  const benchWrap = document.getElementById("myPitchBench");
  let rows = "";
  POS_ORDER.forEach((pos) => {
    const inPos = current.filter((p) => p.pos === pos && p.isStarting);
    if (inPos.length) rows += `<div class="pitch-row">${inPos.map(jerseyHTML).join("")}</div>`;
  });
  startWrap.innerHTML = rows;
  benchWrap.innerHTML = current.filter((p) => !p.isStarting).map(jerseyHTML).join("");
  [...startWrap.querySelectorAll(".player-card"), ...benchWrap.querySelectorAll(".player-card")]
    .forEach((el) => el.addEventListener("click", () => openPlayerDetail(parseInt(el.dataset.pid))));

  renderTransferSuggestions(current, ft);
}

function bestSingleSwap(current, excludeIds) {
  const budgetLeft = BUDGET - squadCost(current);
  const counts = teamCounts(current);
  let best = null;

  current.forEach((out) => {
    const candidates = DATA.players.filter((p) =>
      p.pos === out.pos &&
      !current.some((c) => c.id === p.id) &&
      !excludeIds.has(p.id) &&
      p.cost <= out.cost + budgetLeft + 1e-6 &&
      (counts[p.team_id] || 0) + (p.team_id === out.team_id ? 0 : 1) <= 3
    );
    candidates.forEach((inP) => {
      const gain = inP.xP_3gw - out.xP_3gw;
      if (!best || gain > best.gain) best = { out, in: inP, gain, costDelta: inP.cost - out.cost };
    });
  });
  return best;
}

function renderTransferSuggestions(current, ft) {
  const host = document.getElementById("transferSuggestions");
  const single = bestSingleSwap(current, new Set());

  if (!single || single.gain <= 0) {
    host.innerHTML = `<div class="card"><div class="card-title">Hold</div><div class="card-sub">No swap in the player pool beats what you already have over the next 3 gameweeks. Sit tight.</div></div>`;
    return;
  }

  let html = `
    <div class="card">
      <div class="card-sub" style="margin-bottom:8px;">1 transfer · free</div>
      <div class="transfer-suggestion">
        <span class="out-name">${single.out.name}</span>
        <span class="transfer-arrow">→</span>
        <span class="in-name">${single.in.name}</span>
        <span class="gain-badge">+${single.gain.toFixed(1)}</span>
      </div>
      <div class="card-sub" style="margin-top:6px;">${single.costDelta >= 0 ? "Costs" : "Frees up"} ${fmtM(Math.abs(single.costDelta))} · ${single.in.team} ${single.in.status !== "a" ? "· ⚠ check fitness" : ""}</div>
    </div>`;

  // second transfer: apply the first hypothetically, then search again
  const afterFirst = current.filter((p) => p.id !== single.out.id).concat([{ ...single.in, isStarting: single.out.isStarting, isCaptain: false, isVice: false }]);
  const second = bestSingleSwap(afterFirst, new Set([single.in.id]));
  if (second && second.gain > 0) {
    const hit = ft >= 2 ? 0 : 4;
    const netGain = single.gain + second.gain - hit;
    html += `
      <div class="card">
        <div class="card-sub" style="margin-bottom:8px;">2 transfers · ${hit ? "costs a 4pt hit" : "both free (rolled transfer)"}</div>
        <div class="transfer-suggestion" style="margin-bottom:8px;">
          <span class="out-name">${single.out.name}</span><span class="transfer-arrow">→</span><span class="in-name">${single.in.name}</span>
        </div>
        <div class="transfer-suggestion">
          <span class="out-name">${second.out.name}</span><span class="transfer-arrow">→</span><span class="in-name">${second.in.name}</span>
          <span class="gain-badge ${netGain <= 0 ? "hit" : ""}">${netGain >= 0 ? "+" : ""}${netGain.toFixed(1)} net</span>
        </div>
      </div>`;
  }

  host.innerHTML = html;
}

/* -------------------------------- nav wiring ------------------------------- */

function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
      if (btn.dataset.view === "transfers") renderTransfersTab();
      if (btn.dataset.view === "fixtures") renderFixturesTab();
    });
  });
}

/* ---------------------------------- boot ----------------------------------- */

(async function init() {
  document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="loader" id="bootLoader">Loading this week\'s data…</div>');
  const ok = await loadData();
  const loader = document.getElementById("bootLoader");
  if (loader) loader.remove();
  if (!ok) return;

  initNav();
  initSquadTab();
  initPlayersTab();
  renderFixturesTab();
})();
