const $ = (id) => document.getElementById(id);
let state = null;
let renderInterval = null;
let sitesSignature = null;
let historySignature = null;

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.2 5.6c0-.8.9-1.3 1.6-.9l9.2 6.4c.6.4.6 1.4 0 1.8l-9.2 6.4c-.7.4-1.6-.1-1.6-.9V5.6Z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.8" y="5" width="4" height="14" rx="1.4"/><rect x="13.2" y="5" width="4" height="14" rx="1.4"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function renderSites(sites) {
  const list = $("blockedList");
  list.replaceChildren();
  if (!sites.length) {
    const empty = document.createElement("div");
    empty.className = "empty-history";
    empty.textContent = "No sites yet.";
    list.append(empty);
    return;
  }
  sites.forEach((site, index) => {
    const chip = document.createElement("div");
    chip.className = "site-chip";
    chip.style.animationDelay = `${Math.min(index * 30, 240)}ms`;
    const name = document.createElement("span");
    name.textContent = site;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.innerHTML = ICON_REMOVE;
    remove.setAttribute("aria-label", `Remove ${site}`);
    remove.addEventListener("click", async () => {
      await send("REMOVE_SITE", { site });
      await refresh();
    });
    chip.append(name, remove);
    list.append(chip);
  });
}

function renderHistory(history) {
  const list = $("historyList");
  list.replaceChildren();
  $("historyCount").textContent = `${history.length} SAVED`;
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-history";
    empty.textContent = "No sessions yet.";
    list.append(empty);
    return;
  }
  history.slice(0, 5).forEach(item => {
    const row = document.createElement("div");
    row.className = "history-item";
    const date = document.createElement("span");
    date.textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(item.completedAt));
    const duration = document.createElement("strong");
    duration.textContent = `${item.minutes} min`;
    row.append(date, duration);
    list.append(row);
  });
}

function render(nextState) {
  state = nextState;
  const timer = state.timer;
  const remaining = timer.running ? Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000)) : timer.remaining;
  const elapsed = Math.max(0, timer.duration - remaining);
  const progress = timer.duration ? Math.min(360, elapsed / timer.duration * 360) : 0;

  $("timerDisplay").textContent = formatTime(remaining);
  $("timerOrbit").style.background = `conic-gradient(from -90deg, #a99cff ${progress}deg, rgba(255,255,255,.12) ${progress}deg)`;
  $("timerLabel").textContent = timer.running ? "FOCUSING" : (remaining < timer.duration ? "PAUSED" : "READY");
  $("startButtonText").textContent = timer.running ? "Pause session" : (remaining < timer.duration ? "Resume focusing" : "Start focusing");
  $("startButtonIcon").innerHTML = timer.running ? ICON_PAUSE : ICON_PLAY;
  $("timerOrbit").classList.toggle("is-running", timer.running);
  $("liveStatus").classList.toggle("is-running", timer.running);
  $("statusText").textContent = timer.running ? "Focusing" : (remaining < timer.duration ? "Paused" : "Ready");

  setStat("todayMinutes", `${state.today.minutes}<span>m</span>`, state.today.minutes);
  setStat("todaySessions", state.today.sessions, state.today.sessions);
  const pct = Math.min(100, Math.round(state.today.minutes / state.goalMinutes * 100));
  setStat("goalProgress", `${pct}<span>%</span>`, pct);
  $("goalBar").style.width = `${pct}%`;
  $("goalDone").textContent = `${state.today.minutes} min`;
  $("goalTotal").textContent = `${state.goalMinutes} min goal`;
  if ($("goalSelect").value !== String(state.goalMinutes)) $("goalSelect").value = String(state.goalMinutes);
  if ($("blockerToggle").checked !== state.blockerEnabled) $("blockerToggle").checked = state.blockerEnabled;
  $("shieldStatus").classList.toggle("is-up", state.blockerEnabled);
  $("shieldText").textContent = state.blockerEnabled ? "On — blocked sites can't open." : "Off — blocked sites open normally.";

  document.querySelectorAll(".duration-option").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.minutes) * 60 === timer.duration);
    button.disabled = timer.running;
  });
  const nextSites = JSON.stringify(state.blockedSites);
  if (nextSites !== sitesSignature) {
    sitesSignature = nextSites;
    renderSites(state.blockedSites);
  }
  const nextHistory = JSON.stringify(state.history);
  if (nextHistory !== historySignature) {
    historySignature = nextHistory;
    renderHistory(state.history);
  }
}

function setStat(id, html, value) {
  const el = $(id);
  if (el.dataset.value === String(value)) return;
  el.innerHTML = html;
  el.dataset.value = String(value);
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

async function refresh() {
  try {
    const result = await send("GET_STATE");
    if (result?.ok === false) throw new Error(result.error || "Could not load Silo.");
    render(result);
  } catch (error) {
    $("blockerNote").textContent = `Error: ${error.message}`;
  }
}

const tabGlider = $("tabGlider");

function moveGlider(tab) {
  if (!tab) return;
  const parent = tab.parentElement.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  tabGlider.style.width = `${rect.width}px`;
  tabGlider.style.transform = `translateX(${rect.left - parent.left}px)`;
}

function activateTab(tab) {
  document.querySelectorAll(".tab").forEach(item => {
    const active = item === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".panel").forEach(panel => {
    panel.hidden = panel.id !== `panel-${tab.dataset.tab}`;
  });
  moveGlider(tab);
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => activateTab(tab));
});
window.addEventListener("resize", () => moveGlider(document.querySelector(".tab.is-active")));
requestAnimationFrame(() => moveGlider(document.querySelector(".tab.is-active")));
if (document.fonts?.ready) document.fonts.ready.then(() => moveGlider(document.querySelector(".tab.is-active")));

document.querySelectorAll(".duration-option").forEach(button => {
  button.addEventListener("click", async () => {
    if (state?.timer.running) return;
    const result = await send("SET_DURATION", { minutes: Number(button.dataset.minutes) });
    if (!result?.ok) $("blockerNote").textContent = result?.error || "Could not change timer.";
    await refresh();
  });
});

$("startPauseBtn").addEventListener("click", async () => {
  const result = await send(state?.timer.running ? "PAUSE_TIMER" : "START_TIMER");
  if (!result?.ok) $("blockerNote").textContent = result?.error || "Timer action failed.";
  await refresh();
});

$("resetBtn").addEventListener("click", async () => {
  await send("RESET_TIMER");
  await refresh();
});

$("goalSelect").addEventListener("change", async event => {
  await send("SET_GOAL", { minutes: Number(event.target.value) });
  await refresh();
});

$("blockerToggle").addEventListener("change", async event => {
  const result = await send("SET_BLOCKER", { enabled: event.target.checked });
  if (!result?.ok) $("blockerNote").textContent = result?.error || "Could not update blocker.";
  await refresh();
});

$("addSiteForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = $("siteInput");
  const button = $("addSiteBtn");
  const site = input.value.trim();
  if (!site) {
    input.focus();
    return;
  }
  button.disabled = true;
  const result = await send("ADD_SITE", { site });
  button.disabled = false;
  if (!result?.ok) {
    $("blockerNote").textContent = result?.error || "Could not add website.";
    const form = $("addSiteForm");
    form.classList.remove("is-error");
    void form.offsetWidth;
    form.classList.add("is-error");
    input.focus();
    return;
  }
  input.value = "";
  $("blockerNote").textContent = "Added.";
  input.focus();
  await refresh();
});

$("addSiteForm").addEventListener("animationend", event => {
  if (event.animationName === "shake") event.currentTarget.classList.remove("is-error");
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "STATE_UPDATED") refresh();
});

refresh();
renderInterval = setInterval(() => {
  if (state) render(state);
}, 1000);
