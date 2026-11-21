const PHRASE = "i want to quit my focus";

const params = new URLSearchParams(location.search);
const rawSite = (params.get("site") || "").trim().toLowerCase();
const validSite = /^[a-z0-9.-]+$/.test(rawSite) && (rawSite === "localhost" || rawSite.includes("."));
const site = validSite ? rawSite.replace(/^www\./, "") : "";

const gate = document.getElementById("gate");
const quitToggle = document.getElementById("quitToggle");
const quitForm = document.getElementById("quitForm");
const quitInput = document.getElementById("quitInput");
const gateError = document.getElementById("gateError");
const confirmQuit = document.getElementById("confirmQuit");

if (site) document.getElementById("siteLabel").textContent = site;

async function send(type) {
  try {
    return await chrome.runtime.sendMessage({ type });
  } catch (_) {
    return {};
  }
}

async function quitLocally() {
  const stored = await chrome.storage.local.get("timer");
  const patch = { blockerEnabled: false };
  if (stored.timer) {
    patch.timer = { ...stored.timer, running: false, endAt: null, remaining: stored.timer.duration };
  }
  await chrome.storage.local.set(patch);
  try { await chrome.alarms.clear("siloTimer"); } catch (_) {}
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(rule => rule.id) });
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

document.getElementById("stayBtn").addEventListener("click", async () => {
  const result = await send("CLOSE_TAB");
  if (!result?.ok) {
    if (history.length > 1) history.back();
    else location.replace("about:blank");
  }
});

quitToggle.addEventListener("click", () => {
  gate.hidden = false;
  quitToggle.setAttribute("aria-expanded", "true");
  gate.scrollIntoView({ behavior: "smooth", block: "nearest" });
  quitInput.focus();
});

document.getElementById("cancelQuit").addEventListener("click", () => {
  gate.hidden = true;
  quitToggle.setAttribute("aria-expanded", "false");
  gateError.textContent = "";
  quitInput.value = "";
  quitToggle.focus();
});

quitInput.addEventListener("input", () => {
  gateError.textContent = "";
});

function shakeGate() {
  gate.classList.remove("is-shake");
  void gate.offsetWidth;
  gate.classList.add("is-shake");
}

gate.addEventListener("animationend", (event) => {
  if (event.animationName === "shake") gate.classList.remove("is-shake");
});

quitForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (normalize(quitInput.value) !== PHRASE) {
    gateError.textContent = "Type the sentence exactly to continue.";
    shakeGate();
    quitInput.focus();
    quitInput.select();
    return;
  }
  confirmQuit.disabled = true;
  const label = confirmQuit.textContent;
  confirmQuit.textContent = "Turning off…";
  let ok = false;
  const result = await send("QUIT_FOCUS");
  ok = Boolean(result?.ok);
  if (!ok) {
    try {
      await quitLocally();
      ok = true;
    } catch (_) {}
  }
  if (ok) {
    location.replace(site ? `https://${site}` : "about:blank");
  } else {
    confirmQuit.disabled = false;
    confirmQuit.textContent = label;
    gateError.textContent = "Could not reach Silo. Reload this tab and try again.";
    shakeGate();
  }
});
