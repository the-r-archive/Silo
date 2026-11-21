const DEFAULTS = {
  goalMinutes: 120,
  blockerEnabled: true,
  blockedSites: ["youtube.com", "instagram.com", "facebook.com", "reddit.com"],
  today: { date: dateKey(), minutes: 0, sessions: 0 },
  history: [],
  timer: { duration: 25 * 60, remaining: 25 * 60, running: false, endAt: null }
};

function dateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function getData() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const data = { ...DEFAULTS, ...stored };
  if (!data.today || data.today.date !== dateKey()) {
    data.today = { date: dateKey(), minutes: 0, sessions: 0 };
    await chrome.storage.local.set({ today: data.today });
  }
  return data;
}

async function broadcastState() {
  try { await chrome.runtime.sendMessage({ type: "STATE_UPDATED" }); } catch (_) {}
}

async function save(patch) {
  await chrome.storage.local.set(patch);
  await broadcastState();
}

function normalizeDomain(value) {
  let input = String(value || "").trim().toLowerCase();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (!host || (!host.includes(".") && host !== "localhost")) return null;
    if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.endsWith(".")) return null;
    return host;
  } catch (_) {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function reloadMatchingOpenTabs(sites) {
  if (!sites.length) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      try {
        const host = new URL(tab.url).hostname.replace(/^www\./, "");
        if (sites.some(site => host === site || host.endsWith(`.${site}`))) {
          await chrome.tabs.reload(tab.id);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

async function syncBlockRules({ reloadTabs = false } = {}) {
  const data = await getData();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = [];
  if (data.blockerEnabled) {
    data.blockedSites.slice(0, 30).forEach((domain, index) => {
      addRules.push({
        id: 1000 + index,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: `${chrome.runtime.getURL("blocked.html")}?site=${encodeURIComponent(domain)}`
          }
        },
        condition: {
          regexFilter: `^https?://(?:[^/]+\\.)?${escapeRegExp(domain)}(?::\\d+)?(?:[/?#]|$)`,
          resourceTypes: ["main_frame"]
        }
      });
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(rule => rule.id),
    addRules
  });
  if (reloadTabs && addRules.length) await reloadMatchingOpenTabs(data.blockedSites);
}

async function getState() {
  const data = await getData();
  const remaining = data.timer.running
    ? Math.max(0, Math.ceil((data.timer.endAt - Date.now()) / 1000))
    : data.timer.remaining;
  return {
    ...data,
    timer: { ...data.timer, remaining }
  };
}

async function completeSession() {
  const data = await getData();
  if (!data.timer.running) return;
  const minutes = Math.max(1, Math.round(data.timer.duration / 60));
  const today = {
    ...data.today,
    minutes: data.today.minutes + minutes,
    sessions: data.today.sessions + 1
  };
  const history = [{ minutes, completedAt: Date.now() }, ...data.history].slice(0, 30);
  const timer = { ...data.timer, running: false, endAt: null, remaining: data.timer.duration };
  await chrome.alarms.clear("siloTimer");
  await save({ today, history, timer });
  await syncBlockRules();
  try {
    await chrome.notifications.create("silo-complete", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Focus session complete",
      message: `You completed ${minutes} minutes of focused time. Take a short break.`,
      priority: 1
    });
  } catch (_) {}
}

async function startTimer() {
  const data = await getData();
  if (data.timer.running) return;
  const remaining = Math.max(1, data.timer.remaining);
  const timer = { ...data.timer, running: true, endAt: Date.now() + remaining * 1000 };
  await save({ timer });
  await chrome.alarms.create("siloTimer", { when: timer.endAt });
  await syncBlockRules({ reloadTabs: true });
}

async function pauseTimer() {
  const data = await getData();
  if (!data.timer.running) return;
  const remaining = Math.max(0, Math.ceil((data.timer.endAt - Date.now()) / 1000));
  if (remaining <= 0) {
    await completeSession();
    return;
  }
  const timer = { ...data.timer, running: false, endAt: null, remaining };
  await chrome.alarms.clear("siloTimer");
  await save({ timer });
  await syncBlockRules();
}

async function resetTimer() {
  const data = await getData();
  const timer = { ...data.timer, running: false, endAt: null, remaining: data.timer.duration };
  await chrome.alarms.clear("siloTimer");
  await save({ timer });
  await syncBlockRules();
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  const data = await getData();
  if (data.timer.running && data.timer.endAt) {
    if (data.timer.endAt <= Date.now()) await completeSession();
    else await chrome.alarms.create("siloTimer", { when: data.timer.endAt });
  }
  await syncBlockRules();
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await getData();
  if (data.timer.running && data.timer.endAt) {
    if (data.timer.endAt <= Date.now()) await completeSession();
    else await chrome.alarms.create("siloTimer", { when: data.timer.endAt });
  }
  await syncBlockRules();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "siloTimer") return;
  const data = await getData();
  if (data.timer.running && data.timer.endAt && data.timer.endAt <= Date.now()) {
    await completeSession();
  } else if (data.timer.running && data.timer.endAt) {
    await chrome.alarms.create("siloTimer", { when: data.timer.endAt });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATE":
        sendResponse(await getState());
        break;
      case "START_TIMER":
        await startTimer();
        sendResponse({ ok: true });
        break;
      case "PAUSE_TIMER":
        await pauseTimer();
        sendResponse({ ok: true });
        break;
      case "RESET_TIMER":
        await resetTimer();
        sendResponse({ ok: true });
        break;
      case "SET_DURATION": {
        const data = await getData();
        if (data.timer.running) {
          sendResponse({ ok: false, error: "Pause your session before changing its duration." });
          break;
        }
        const seconds = Math.max(1, Math.min(180, Number(message.minutes) || 25)) * 60;
        await save({ timer: { duration: seconds, remaining: seconds, running: false, endAt: null } });
        sendResponse({ ok: true });
        break;
      }
      case "SET_GOAL": {
        const minutes = Math.max(15, Math.min(720, Number(message.minutes) || 120));
        await save({ goalMinutes: minutes });
        sendResponse({ ok: true });
        break;
      }
      case "SET_BLOCKER":
        await save({ blockerEnabled: Boolean(message.enabled) });
        await syncBlockRules({ reloadTabs: Boolean(message.enabled) });
        sendResponse({ ok: true });
        break;
      case "ADD_SITE": {
        const domain = normalizeDomain(message.site);
        if (!domain) {
          sendResponse({ ok: false, error: "Enter a valid domain, such as example.com." });
          break;
        }
        const data = await getData();
        if (data.blockedSites.includes(domain)) {
          sendResponse({ ok: false, error: "That website is already on your list." });
          break;
        }
        if (data.blockedSites.length >= 30) {
          sendResponse({ ok: false, error: "You can add up to 30 websites." });
          break;
        }
        const blockedSites = [...data.blockedSites, domain];
        await save({ blockedSites });
        await syncBlockRules({ reloadTabs: true });
        sendResponse({ ok: true });
        break;
      }
      case "REMOVE_SITE": {
        const data = await getData();
        const blockedSites = data.blockedSites.filter(site => site !== message.site);
        await save({ blockedSites });
        await syncBlockRules();
        sendResponse({ ok: true });
        break;
      }
      case "QUIT_FOCUS": {
        const data = await getData();
        const timer = { ...data.timer, running: false, endAt: null, remaining: data.timer.duration };
        await chrome.alarms.clear("siloTimer");
        await save({ timer, blockerEnabled: false });
        try { await syncBlockRules(); } catch (_) {}
        sendResponse({ ok: true });
        break;
      }
      case "CLOSE_TAB": {
        const tabId = sender?.tab?.id;
        if (tabId === undefined) {
          sendResponse({ ok: false });
          break;
        }
        const tabs = await chrome.tabs.query({});
        if (tabs.length <= 1) {
          sendResponse({ ok: false });
          break;
        }
        await chrome.tabs.remove(tabId);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown Silo action." });
    }
  })().catch(error => {
    sendResponse({ ok: false, error: error?.message || "Something went wrong." });
  });
  return true;
});
