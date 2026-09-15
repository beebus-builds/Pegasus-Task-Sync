/**
 * Pegasus Free Logger - Apps Script backend v1.5
 * Sheet: https://docs.google.com/spreadsheets/d/1Q3KK1jQQUQKGi7CzIzqMdlyZJTRRaIuiErthsBB4sqo/edit
 * Paste entire file into Extensions > Apps Script > Code.gs, Save, Deploy > New version.
 * No secret token — open endpoint.
 * All times in Nepal Time (Asia/Kathmandu, UTC+5:45).
 * Each day gets its own sheet named YYYY-MM-DD (e.g. 2026-09-15) — full activity log.
 * A separate "Team Status" tab holds ONE row per person, upserted by name, showing
 * their current Free/Busy status at a glance — this is what the auto-sync on reload updates.
 * Midnight trigger auto-creates tomorrow's daily-log sheet.
 *
 * Daily log columns:
 * npt_time | name | myTaskCount | task_name | task_url | task_brief | free_response | free_since | mins_left_to_6pm | assigned_tasks
 * free_response reads like: "Yes, I'm working — Task Name"
 *
 * Team Status columns:
 * name | status | current_task | task_url | myTaskCount | mins_left_to_6pm | last_updated
 */

const SHEET_ID = "1Q3KK1jQQUQKGi7CzIzqMdlyZJTRRaIuiErthsBB4sqo";
const HEADERS = ["npt_time", "name", "myTaskCount", "task_name", "task_url", "task_brief", "free_response", "free_since", "mins_left_to_6pm", "assigned_tasks"];

// ---------- Live team status tab (one row per person, upserted) ----------
const STATUS_SHEET_NAME = "Team Status";
const STATUS_HEADERS = ["name", "status", "current_task", "task_url", "myTaskCount", "mins_left_to_6pm", "last_updated"];

// ---------- NPT helpers ----------
function getNptDate() {
  return Utilities.formatDate(new Date(), "Asia/Kathmandu", "yyyy-MM-dd");
}
function getNptTime() {
  return new Date().toLocaleString("en-CA", { timeZone: "Asia/Kathmandu", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false });
}

// ---------- Sheet management ----------
function getOrCreateSheet(dateStr) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(dateStr);
  if (!sheet) {
    sheet = ss.insertSheet(dateStr);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    // format columns
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold").setBackground("#e8eaed");
  }
  return sheet;
}

function getOrCreateStatusSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(STATUS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(STATUS_SHEET_NAME, 0);
    sheet.getRange(1, 1, 1, STATUS_HEADERS.length).setValues([STATUS_HEADERS]);
    sheet.getRange(1, 1, 1, STATUS_HEADERS.length).setFontWeight("bold").setBackground("#e8eaed");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Upserts one row per person keyed by name (case-insensitive) with their latest free/busy status.
function upsertStatus(d) {
  const sheet = getOrCreateStatusSheet();
  const name = (d.name || "unknown").trim();
  const lastRow = sheet.getLastRow();
  let rowIndex = -1;
  if (lastRow > 1) {
    const names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < names.length; i++) {
      if (String(names[i][0]).trim().toLowerCase() === name.toLowerCase()) { rowIndex = i + 2; break; }
    }
  }
  const rowValues = [
    name,
    d.status || (Number(d.myTaskCount) > 0 ? "Busy" : "Free"),
    d.task_name || "",
    d.task_url || "",
    d.myTaskCount != null && d.myTaskCount !== "" ? Number(d.myTaskCount) : "",
    d.mins_left_to_6pm != null && d.mins_left_to_6pm !== "" ? Number(d.mins_left_to_6pm) : "",
    d.npt_time || getNptTime()
  ];
  if (rowIndex === -1) {
    sheet.appendRow(rowValues);
  } else {
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  }
  const finalRows = sheet.getLastRow();
  if (finalRows > 2) sheet.getRange(2, 1, finalRows - 1, STATUS_HEADERS.length).sort(1);
}

// ---------- Midnight trigger ----------
function createTodaysSheet() {
  const dateStr = getNptDate();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  if (!ss.getSheetByName(dateStr)) {
    const sheet = ss.insertSheet(dateStr);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold").setBackground("#e8eaed");
  }
}

function createMidnightTrigger() {
  // Remove old triggers first so we don't stack duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("createTodaysSheet")
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .create();
}

// Runs once when you paste this in (call manually first time to set up trigger)
function setup() {
  createTodaysSheet();
  createMidnightTrigger();
}

// ---------- Handlers ----------
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, msg: "Pegasus Free Logger alive. Sheets by date. Call setup() once to enable midnight trigger." }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || "{}";
    const d = JSON.parse(raw);

    const dateStr = d.npt_date || d.npt_time || getNptDate();
    const sheet = getOrCreateSheet(dateStr);

    const row = [
      d.npt_time || getNptTime(),
      d.name || "unknown",
      d.myTaskCount != null && d.myTaskCount !== "" ? Number(d.myTaskCount) : "",
      d.task_name || "",
      d.task_url || "",
      d.task_brief || "",
      d.free_response || "",
      d.free_since || "",
      d.mins_left_to_6pm != null && d.mins_left_to_6pm !== "" ? Number(d.mins_left_to_6pm) : "",
      (d.assigned_tasks || "") + (d.assigned_count != null ? " [n=" + d.assigned_count + "]" : "") + (d.note ? " note=" + d.note : "")
    ];
    sheet.appendRow(row);
    upsertStatus(d);

    return json_({ ok: true, sheet: dateStr });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
