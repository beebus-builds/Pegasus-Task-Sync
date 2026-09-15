// Pegasus Free Logger v1.5 - content script
// Exact URL only: https://pegasus.pairlab.ai/xapp/my-tasks
// Status (Free/Busy) is auto-detected and synced on every reload — no click required.
// Banner just confirms what was synced and offers a manual override if detection is wrong.
// Backend upserts a live "Team Status" tab (one row per person) plus the daily log.
// Daily log columns: npt_time | name | myTaskCount | task_name | task_url | task_brief | free_response | free_since | mins_left_to_6pm | assigned_tasks

const SHEET_ID = "1Q3KK1jQQUQKGi7CzIzqMdlyZJTRRaIuiErthsBB4sqo";
const DEFAULT_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxO7rt2dWNKW2i3Z9zSRdGc8VpJViTTiqnMvGxGKoteZNp-OzHYVf-JKIgX__IqXzh34w/exec";
const ALLOWED_URL = "https://pegasus.pairlab.ai/xapp/my-tasks";
function nowISO() { return new Date().toLocaleString("en-CA", { timeZone: "Asia/Kathmandu", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }).replace(/[ :]/g, "-").slice(0, 19) + "+05:45"; }
function now() { return new Date(); }
function getNptStrings(at = new Date()) { return at.toLocaleString("en-CA", { timeZone: "Asia/Kathmandu", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }); }
function getMinsLeftTo6pmKathmandu(at = new Date()) { const npt = new Date(at.toLocaleString("en-US", { timeZone: "Asia/Kathmandu" })); const target = new Date(npt); target.setHours(18, 0, 0, 0); return Math.max(0, Math.round((target.getTime() - npt.getTime()) / 60000)); }
async function getConfig() { const s = await chrome.storage.sync.get(["appsScriptUrl"]); return { appsScriptUrl: ((s.appsScriptUrl || "").trim() || DEFAULT_APPS_SCRIPT_URL) }; }

let loggedThisLoad = false;
let pageData = { name: null, myTaskCount: null, tasks: [], activeTask: null, domCount: null, bridgeCount: null };
let bannerShown = false;
const POLL_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;
const DEBUG = true;
function log(...a) { if (DEBUG) console.log("[PFL]", ...a); }

function isAllowedUrl() { const base = location.href.split(/[?#]/)[0].replace(/\/$/, ""); return base === ALLOWED_URL || base.startsWith(ALLOWED_URL + "/"); }

// ---- Page bridge removed to avoid CSP inline script error ---- 
function injectPageBridge() {
  // No-op: page bridge removed due to CSP. DOM scraping is used instead.
  log("bridge skipped due to CSP");
}

// ---- Scrape active task from DOM sections (Recently Assigned / Due Today / Upcoming) ----
function scrapeActiveTask() {
  // Try to find task rows in the main sections
  const selectors = [
    'a[href*="/tasks/ac-task/"]',
    'a[href*="/tasks/"]:not([href*="/my-tasks"]):not([href*="/tasks?"])',
    '[class*="task"] a, [class*="item"] a, a[href*="/tasks/"]'
  ];
  for (const sel of selectors) {
    const links = [...document.querySelectorAll(sel)];
    for (const a of links) {
      const hrefRaw = a.getAttribute("href") || "";
      if (!hrefRaw.includes("/tasks/") || hrefRaw.includes("/my-tasks") || hrefRaw.includes("/tasks?")) continue;
      if (/my-tasks\s*$|my-tickets\s*$|group-tasks\s*$|tickets\s*$/.test(hrefRaw)) continue;
      const href = hrefRaw.startsWith("http") ? hrefRaw : location.origin + (hrefRaw.startsWith("/") ? hrefRaw : "/" + hrefRaw);
      // Walk up to find the closest row/container for brief text
      let brief = "";
      const row = a.closest("tr, li, div[class*='row'], div[class*='item'], div[class*='card']");
      if (row) {
        brief = row.textContent.replace(/\s+/g, " ").trim().slice(0, 300);
      }
      if (!brief) brief = a.textContent.replace(/\s+/g, " ").trim().slice(0, 300);
      const name = (a.textContent || a.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 150) || "Untitled";
      if (name && href) return { name, url: href, brief };
    }
  }
  return null;
}

function scrapeTasks() {
  const out = [];
  document.querySelectorAll('a[href*="/my-tasks/"], a[href*="/tasks/"]').forEach(a => {
    const href = a.getAttribute("href") || "";
    if (/my-tasks\s*$|my-tickets\s*$|group-tasks\s*$|tickets\s*$/.test(href)) return;
    const t = (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 150);
    if (t.length > 3 && !/^(my tasks|my tickets|group tasks|dashboard)$/i.test(t)) out.push(t + " [" + href.slice(-40) + "]");
  });
  const seen = new Set();
  return out.filter(x => !seen.has(x) && seen.add(x)).slice(0, 50);
}

function readDom() {
  let name = null, myTaskCount = null;
  const els = [...document.querySelectorAll('[data-globals="myTaskCount"]')];
  for (const el of els) { 
    const txt = (el.textContent || "").trim();
    const n1 = parseInt(txt, 10);
    if (!Number.isNaN(n1)) { myTaskCount = n1; break; }
    const dataVal = el.getAttribute("data-value") || el.dataset.value;
    const n2 = parseInt(dataVal, 10);
    if (!Number.isNaN(n2)) { myTaskCount = n2; break; }
  }
  if (myTaskCount == null) { const tab = document.querySelector('a[href*="/my-tasks"] span, a[href*="/my-tasks"]'); if (tab) { const m = (tab.textContent || "").match(/\d+/); if (m) myTaskCount = parseInt(m[0], 10); } }
  if (myTaskCount == null) { const m = document.body.innerText.match(/My Tasks[\s\(]*(\d+)[\)\s]*/i); if (m) myTaskCount = parseInt(m[1], 10); }
  if (myTaskCount == null) { const m = document.body.innerText.match(/(\d+)\s*tasks?/i); if (m) myTaskCount = parseInt(m[1], 10); }
  // Some pages render count in a badge with class containing 'badge' or 'count' near my-tasks link
  if (myTaskCount == null) {
    const link = document.querySelector('a[href*="/my-tasks"]');
    if (link) {
      const badge = link.querySelector('.badge, .count, span');
      if (badge) { const m = (badge.textContent || "").match(/\d+/); if (m) myTaskCount = parseInt(m[0], 10); }
    }
  }
  const img = document.querySelector('img[alt]');
  if (img && img.alt && img.alt.length > 1 && !/logo|company/i.test(img.alt)) name = img.alt.trim();
  if (!name) { const m = document.body.textContent.match(/Welcome back,?\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/); if (m) name = m[1]; }
  const tasks = scrapeTasks();
  const activeTask = scrapeActiveTask();
  return { name, myTaskCount, tasks, activeTask };
}

function currentBestCount() {
  if (pageData.bridgeCount != null && !Number.isNaN(pageData.bridgeCount)) return pageData.bridgeCount;
  if (pageData.domCount != null && !Number.isNaN(pageData.domCount)) return pageData.domCount;
  return pageData.myTaskCount;
}

function refreshSnapshot(reason) {
  const dom = readDom();
  if (dom.name && !pageData.name) pageData.name = dom.name;
  if (dom.name) pageData.name = pageData.name || dom.name;
  if (dom.myTaskCount != null) pageData.domCount = dom.myTaskCount;
  pageData.tasks = dom.tasks;
  pageData.activeTask = dom.activeTask;
  const best = currentBestCount();
  if (best != null) pageData.myTaskCount = best;
  log("snapshot", reason, JSON.stringify({ name: pageData.name, count: pageData.myTaskCount, tasks: pageData.tasks.length, activeTask: pageData.activeTask ? pageData.activeTask.name + " " + pageData.activeTask.url.slice(-30) : null }));
  // Update extension badge
  try { chrome.runtime.sendMessage({ type: "PFL_BADGE_UPDATE", count: best ?? 0 }); } catch(e){}
  return best;
}

async function logToSheet({ free_response = null, note = "", status = null, force = false } = {}) {
  if (!isAllowedUrl()) return { ok: false, reason: "blocked: only runs on " + ALLOWED_URL };
  if (loggedThisLoad && !force) return { ok: false, reason: "already logged this load (use popup Log now to force)" };
  refreshSnapshot("pre-log");
  const { appsScriptUrl } = await getConfig();
  if (!appsScriptUrl) return { ok: false, reason: "Apps Script URL not set." };
  const count = currentBestCount();
  const at = pageData.activeTask;
  const tasks = pageData.tasks || [];
  const effectiveStatus = status || (count > 0 ? "Busy" : "Free");
  const effectiveFreeResponse = free_response ?? (count > 0 ? `Yes, I'm working — ${at ? at.name : "on a task"}` : "Free");
  const payload = {
    npt_time: getNptStrings(now()),
    npt_date: getNptStrings(now()).split(" ")[0],
    npt_iso: nowISO(),
    name: pageData.name || "unknown",
    myTaskCount: count,
    task_name: (at && at.name) || "",
    task_url: (at && at.url) || "",
    task_brief: (at && at.brief) || "",
    status: effectiveStatus,
    free_response: effectiveFreeResponse,
    free_since: count === 0 ? (await chrome.storage.local.get(["freeSince"])).freeSince || null : null,
    mins_left_to_6pm: getMinsLeftTo6pmKathmandu(new Date()),
    assigned_tasks: tasks.map(t => {
      // Try to extract a cleaner task name from strings like "Task Name [url]"
      const m = t.match(/^(.+?)\s*\[/);
      return m ? m[1].trim() : t;
    }).join(", ").slice(0, 4000),
    assigned_count: tasks.length,
    pageUrl: location.href,
    sheetId: SHEET_ID,
    note
  };
  log("POST via background", appsScriptUrl, payload);
  try {
    const r = await chrome.runtime.sendMessage({ type: "PFL_PROXY_POST", url: appsScriptUrl, payload });
    log("POST result", r);
    const text = (r && r.body) || "";
    if (r && r.ok) { loggedThisLoad = true; await chrome.storage.local.set({ lastLogAt: nowISO(), lastLogResult: text.slice(0, 500) }); return { ok: true, reason: text.slice(0, 500) || ("status " + r.status) }; }
    return { ok: false, reason: text.slice(0, 500) || ("status " + (r && r.status)) };
  } catch (e) {
    log("POST failed", e);
    return { ok: false, reason: String(e && e.message || e) };
  }
}

// ---- Banner: status is auto-synced on load; banner just confirms + allows override. ----
function removeBanner() { document.getElementById("pfl-host")?.remove(); bannerShown = false; }

function showStatusBanner(status, count) {
  if (bannerShown) return;
  bannerShown = true;
  removeBanner();
  const isBusy = status === "Busy";
  const at = pageData.activeTask;
  const minsLeft = getMinsLeftTo6pmKathmandu(new Date());
  const taskName = at?.name || "Active task (name not detected)";
  const taskUrl = at?.url || "";
  const taskBrief = at?.brief || "Brief not detected — task is present on page";
  const host = document.createElement("div");
  host.id = "pfl-host";
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:auto;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{all:initial;}
      .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:14px;width:360px;font-family:system-ui,sans-serif;font-size:13px;color:#111;position:relative;pointer-events:auto;}
      .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:6px;}
      .badge.free{background:#dcfce7;color:#166534;}
      .badge.busy{background:#fee2e2;color:#991b1b;}
      .url{color:#0366d6;text-decoration:none;font-size:11px;word-break:break-all;display:block;margin:4px 0 8px;}
      .url:hover{text-decoration:underline;}
      .brief{background:#f6f8fa;border-radius:8px;padding:8px;font-size:12px;color:#374151;max-height:80px;overflow:auto;margin-bottom:8px;word-break:break-word;}
      .row{display:flex;gap:8px;margin-top:8px;}
      .btn{flex:1;background:#e5e7eb;color:#111;border-radius:8px;padding:8px;border:none;font-size:12px;cursor:pointer;}
      .x{position:absolute;top:6px;right:10px;border:none;background:none;font-size:16px;cursor:pointer;color:#6b7280;}
      .msg{margin-top:8px;color:#6b7280;font-size:12px;min-height:16px;}
    </style>
    <div class="card">
      <span class="badge ${isBusy ? "busy" : "free"}">${isBusy ? "BUSY" : "FREE"}</span>
      <div style="font-weight:700;margin-bottom:4px;">✓ Synced to team sheet</div>
      ${isBusy ? `
        <div style="font-weight:600;font-size:14px;margin-bottom:2px;">📌 ${escapeHtml(taskName)}</div>
        ${taskUrl ? `<a class="url" href="${escapeHtml(taskUrl)}" target="_blank">${escapeHtml(taskUrl)}</a>` : `<div style="font-size:11px;color:#6b7280;margin:4px 0 8px;">URL not detected</div>`}
        <div class="brief">${escapeHtml(taskBrief)}</div>
      ` : `<div style="color:#374151;margin-bottom:8px;">0 tasks in My Tasks — marked as free.</div>`}
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">⏰ ${minsLeft} min left until 6pm NPT</div>
      <div class="row"><button class="btn" id="override">Not right? Mark as ${isBusy ? "Free" : "Busy"}</button></div>
      <div class="msg" id="msg"></div>
      <button class="x" id="x">×</button>
    </div>
  `;
  document.body.appendChild(host);
  const msg = (t) => { const el = shadow.getElementById("msg"); if (el) el.textContent = t; };
  shadow.getElementById("x").onclick = () => removeBanner();
  shadow.getElementById("override").onclick = async () => {
    const newStatus = isBusy ? "Free" : "Busy";
    msg("Updating...");
    const free_response = newStatus === "Busy" ? "Busy — manual override" : "Free (manual override)";
    const r = await logToSheet({ free_response, status: newStatus, note: "manual override", force: true });
    if (r.ok) { msg("✓ Updated to " + newStatus); bannerShown = false; showStatusBanner(newStatus, newStatus === "Busy" ? 1 : 0); }
    else msg("Hmm, something went wrong: " + r.reason);
  };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

async function maybeShowBanner(reason) {
  const count = refreshSnapshot(reason);
  log("maybeShow", reason, "count=", count, "bannerShown=", bannerShown, "logged=", loggedThisLoad);
  if (count == null) return count;
  const status = count > 0 ? "Busy" : "Free";
  // Auto-sync status on every load — no click required.
  if (!loggedThisLoad) {
    const at = pageData.activeTask;
    const free_response = status === "Busy" ? `Busy — working on ${at ? at.name : "assigned task"}` : "Free";
    log("auto-logging on load", status);
    const r = await logToSheet({ free_response, status, note: "auto sync on reload" });
    log("auto-log result", r);
  }
  if (!bannerShown) showStatusBanner(status, count);
  return count;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!isAllowedUrl()) { sendResponse({ ok: false, reason: "blocked: only runs on " + ALLOWED_URL }); return; }
    if (msg && msg.type === "PFL_LOG_NOW") {
      loggedThisLoad = false;
      const r = await logToSheet({ free_response: msg.free_response || "manual", note: msg.note || "" });
      sendResponse(r);
    } else if (msg && msg.type === "PFL_TEST_SHEET") {
      loggedThisLoad = false;
      const r = await logToSheet({ free_response: "test_sheet", note: "connectivity test" });
      sendResponse(r);
    } else if (msg && msg.type === "PFL_GET_STATE") {
      refreshSnapshot("popup-state");
      const st = await chrome.storage.local.get(["freeSince", "lastCount", "lastLogAt", "lastLogResult"]);
      sendResponse({ pageData, url: location.href, allowed: isAllowedUrl(), freeSince: st.freeSince || null, minsLeft: getMinsLeftTo6pmKathmandu(new Date()), loggedThisLoad, lastLog: { at: st.lastLogAt || null, result: st.lastLogResult || null } });
    }
  })();
  return true;
});

window.addEventListener("message", (event) => {
  // Bridge removed due to CSP; no-op
});

(async function main() {
  if (!isAllowedUrl()) { log("blocked url", location.href); return; }
  injectPageBridge();
  refreshSnapshot("init");
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) { const c = refreshSnapshot("poll"); if (c != null) break; await new Promise(r => setTimeout(r, POLL_INTERVAL_MS)); }
  await maybeShowBanner("initial");
  // watch for late Alpine updates, ignore own host
  const obs = new MutationObserver((muts) => { for (const m of muts) { if (m.target && m.target.nodeType === 1 && m.target.closest && m.target.closest("#pfl-host")) return; } maybeShowBanner("dom-mutation"); });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(() => obs.disconnect(), 60000);
  log("main done", JSON.stringify(pageData));
})();
