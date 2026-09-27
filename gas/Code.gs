/**
 * shiftflow - 勤務入力 → Googleカレンダー登録
 *
 * スプレッドシートに紐づくスクリプト(拡張機能 → Apps Script)として使う。
 *
 * シート
 *   勤務コード: 番号 | 種別(泊/日勤/休日) | 平日出勤 | 平日退勤 | 休日出勤 | 休日退勤 | 泊
 *   勤務記録  : 日付(yyyy-MM-dd) | 勤務 | 日種別 | メモ  (画面の入力内容。無ければ自動作成)
 *               日種別・メモは画面で手修正したときだけ入る(空なら自動)
 *
 * スクリプトプロパティ
 *   WORK_CALENDAR_ID    勤務用カレンダー(泊・日勤・非番・手入力)
 *   HOLIDAY_CALENDAR_ID 休日用カレンダー(種別が「休日」のもの)
 *
 * 予定はすべて終日。
 *   泊       : タイトル=番号 / メモ=出勤時間
 *   日勤     : タイトル=番号 / メモ=出勤〜退勤 (例: 10:15〜19:02)
 *   非番     : タイトル=「〜」 / メモ=退勤時間 (泊の翌日に自動作成)
 *   休日     : タイトル=番号(特休など) / メモなし
 *   手入力   : タイトル=入力文字 / メモなし
 * 時間は、その日が土日祝なら「休日」、それ以外は「平日」の列を使う。
 * 年末年始など、日種別(平日/休日)とメモは日ごとに手で上書きできる。
 */

const MASTER_SHEET = "勤務コード";
const RECORD_SHEET = "勤務記録";
const RECORD_HEADER = ["日付", "勤務", "日種別", "メモ"];
const APP_TAG = "shiftflow";
const OFFDUTY_TITLE = "〜";
const CALENDAR_WAIT_MS = 100;
const HOLIDAY_CALENDAR_IDS = [
  "ja.japanese.official#holiday@group.v.calendar.google.com",
  "ja.japanese#holiday@group.v.calendar.google.com",
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("勤務登録")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// ---------- 画面から呼ぶ関数 ----------

function getMonthData(year, month) {
  const record = loadRecord();
  const entries = {};
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const key = dateKey(year, month, d);
    if (record[key]) entries[key] = record[key];
  }
  return {
    master: loadMaster(),
    entries: entries,
    prevLastCode: codeOf(record[toKey(new Date(year, month - 1, 0))]),
    holidays: loadHolidays(year, month),
  };
}

function register(year, month, entries) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const master = indexMaster(loadMaster());
    const record = loadRecord();
    const prevLastCode = codeOf(record[toKey(new Date(year, month - 1, 0))]);
    const nextFirstEntry = record[toKey(new Date(year, month, 1))];
    const holidays = loadHolidays(year, month);

    const plan = buildPlan(year, month, entries, prevLastCode, nextFirstEntry, master, holidays);
    saveRecord(year, month, plan.entries);
    applyToCalendars(year, month, plan.events);

    return { count: plan.events.length };
  } finally {
    lock.releaseLock();
  }
}

// 指定月のカレンダー予定(このアプリが作ったものだけ)を削除する。
// 入力内容(勤務記録シート)は残すので、登録し直せば元に戻せる。
function resetMonth(year, month) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return { count: deleteAppEvents(getCalendars(), year, month) };
  } finally {
    lock.releaseLock();
  }
}

// ---------- 予定の組み立て ----------

// 月内の入力から、登録する予定の一覧を作る。
// entries: { "yyyy-MM-dd": { code, dayType, memo } }  (dayType・memoは手修正したときだけ)
// 非番の日は番号を無視し、翌月1日の非番(月末が泊の場合)も含める。
function buildPlan(year, month, entries, prevLastCode, nextFirstEntry, master, holidays) {
  const holidaySet = {};
  holidays.forEach((key) => (holidaySet[key] = true));

  const days = daysInMonth(year, month);
  const cleanEntries = {};
  const events = [];

  for (let d = 1; d <= days + 1; d++) {
    const date = new Date(year, month - 1, d);
    const key = toKey(date);
    const e = normalizeEntry(d > days ? nextFirstEntry : entries[key]);
    const dayType = e.dayType || (isHoliday(date, holidaySet) ? "休日" : "平日");

    const prevCode = d === 1 ? prevLastCode : codeOf(cleanEntries[dateKey(year, month, d - 1)]);
    const prevMaster = master[prevCode];
    if (prevMaster && prevMaster.type === "泊") {
      events.push({
        date: date,
        calendar: "work",
        kind: "offduty",
        title: OFFDUTY_TITLE,
        description: e.memo || pickTime(prevMaster.end, dayType),
      });
      if (d <= days && (e.dayType || e.memo)) {
        cleanEntries[key] = { code: "", dayType: e.dayType, memo: e.memo };
      }
      continue;
    }
    if (d > days) break;

    if (!e.code && !e.dayType && !e.memo) continue;
    cleanEntries[key] = e;
    if (!e.code) continue;

    const entry = master[e.code];
    if (entry && entry.type === "休日") {
      events.push({ date: date, calendar: "holiday", kind: "day", title: e.code, description: e.memo });
    } else {
      events.push({
        date: date,
        calendar: "work",
        kind: "day",
        title: e.code,
        description: e.memo || (entry ? dutyMemo(entry, dayType) : ""),
      });
    }
  }

  return { entries: cleanEntries, events: events };
}

function normalizeEntry(raw) {
  if (!raw) return { code: "", dayType: "", memo: "" };
  if (typeof raw === "string") return { code: raw.trim(), dayType: "", memo: "" };
  const dayType = String(raw.dayType || "").trim();
  return {
    code: String(raw.code || "").trim(),
    dayType: dayType === "平日" || dayType === "休日" ? dayType : "",
    memo: String(raw.memo || "").trim(),
  };
}

function codeOf(entry) {
  return normalizeEntry(entry).code;
}

// 泊は出勤時間だけ、日勤は「出勤〜退勤」
function dutyMemo(entry, dayType) {
  const start = pickTime(entry.start, dayType);
  const end = pickTime(entry.end, dayType);
  return entry.type === "日勤" && start && end ? start + "〜" + end : start;
}

function pickTime(times, dayType) {
  return times[dayType] || times["平日"] || "";
}

function isHoliday(date, holidaySet) {
  const w = date.getDay();
  return w === 0 || w === 6 || !!holidaySet[toKey(date)];
}

// ---------- カレンダー ----------

// このアプリが作った予定(タグ付き)だけを消してから作り直す。
// 翌月1日は、このアプリが作った非番だけを対象にする。
function applyToCalendars(year, month, events) {
  const calendars = getCalendars();
  deleteAppEvents(calendars, year, month);

  events.forEach((e) => {
    const cal = e.calendar === "holiday" ? calendars.holiday : calendars.work;
    const options = e.description ? { description: e.description } : {};
    const ev = withRetry(() => cal.createAllDayEvent(e.title, e.date, options));
    withRetry(() => ev.setTag(APP_TAG, e.kind));
    Utilities.sleep(CALENDAR_WAIT_MS);
  });
}

// カレンダーは短時間に大量に作成・削除すると
// 「too many calendar events」などで失敗することがあるので、待ってから再試行する
function withRetry(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= 4) throw err;
      Utilities.sleep(1000 * Math.pow(2, i));
    }
  }
}

// 対象月の、このアプリが作った予定を削除して件数を返す。
// 翌月1日は、この月の月末の泊から作られる非番だけを対象にする。
function deleteAppEvents(calendars, year, month) {
  const start = new Date(year, month - 1, 1);
  const nextFirst = new Date(year, month, 1);
  const nextSecond = new Date(year, month, 2);

  const targets = [];
  [calendars.work, calendars.holiday].forEach((cal) => {
    cal
      .getEvents(start, nextFirst)
      .filter((ev) => ev.getTag(APP_TAG) !== null)
      .forEach((ev) => targets.push(ev));
  });
  calendars.work
    .getEvents(nextFirst, nextSecond)
    .filter((ev) => ev.getTag(APP_TAG) === "offduty")
    .forEach((ev) => targets.push(ev));

  targets.forEach((ev) => {
    withRetry(() => ev.deleteEvent());
    Utilities.sleep(CALENDAR_WAIT_MS);
  });
  return targets.length;
}

function getCalendars() {
  const props = PropertiesService.getScriptProperties();
  const workId = props.getProperty("WORK_CALENDAR_ID");
  const holidayId = props.getProperty("HOLIDAY_CALENDAR_ID");
  const work = workId && CalendarApp.getCalendarById(workId);
  const holiday = holidayId && CalendarApp.getCalendarById(holidayId);
  if (!work) throw new Error("WORK_CALENDAR_ID のカレンダーが見つかりません。");
  if (!holiday) throw new Error("HOLIDAY_CALENDAR_ID のカレンダーが見つかりません。");
  return { work: work, holiday: holiday };
}

// 対象月 + 翌月1日の祝日を yyyy-MM-dd の配列で返す
function loadHolidays(year, month) {
  let cal = null;
  let official = false;
  for (let i = 0; i < HOLIDAY_CALENDAR_IDS.length && !cal; i++) {
    cal = CalendarApp.getCalendarById(HOLIDAY_CALENDAR_IDS[i]);
    official = i === 0;
  }
  if (!cal) {
    throw new Error("Googleカレンダーに「日本の祝日」を追加してください。");
  }

  return cal
    .getEvents(new Date(year, month - 1, 1), new Date(year, month, 2))
    .filter((ev) => official || !ev.getDescription() || ev.getDescription().indexOf("祝日") !== -1)
    .map((ev) => toKey(ev.getAllDayStartDate()));
}

// ---------- シート ----------

function loadMaster() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MASTER_SHEET);
  if (!sheet) throw new Error("「" + MASTER_SHEET + "」シートがありません。");

  const values = sheet.getDataRange().getDisplayValues();
  const header = values[0].map((h) => h.trim());
  const col = {};
  ["番号", "種別", "平日出勤", "平日退勤", "休日出勤", "休日退勤"].forEach((name) => {
    col[name] = header.indexOf(name);
    if (col[name] === -1) throw new Error("「" + MASTER_SHEET + "」に「" + name + "」列がありません。");
  });

  return values
    .slice(1)
    .filter((row) => row[col["番号"]].trim() !== "")
    .map((row) => ({
      code: row[col["番号"]].trim(),
      type: row[col["種別"]].trim(),
      start: { 平日: normalizeTime(row[col["平日出勤"]]), 休日: normalizeTime(row[col["休日出勤"]]) },
      end: { 平日: normalizeTime(row[col["平日退勤"]]), 休日: normalizeTime(row[col["休日退勤"]]) },
    }));
}

function indexMaster(list) {
  const map = {};
  list.forEach((m) => (map[m.code] = m));
  return map;
}

// "09:01:00" や "(9:01)" などを "9:01" にそろえる
function normalizeTime(value) {
  const m = String(value).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + ":" + m[2] : "";
}

function getRecordSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RECORD_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RECORD_SHEET);
  }
  const header = sheet.getRange(1, 1, 1, RECORD_HEADER.length);
  if (header.getDisplayValues()[0].join() !== RECORD_HEADER.join()) {
    header.setValues([RECORD_HEADER]);
  }
  return sheet;
}

function loadRecord() {
  const record = {};
  getRecordSheet()
    .getDataRange()
    .getDisplayValues()
    .slice(1)
    .forEach((row) => {
      if (row[0] && (row[1] || row[2] || row[3])) {
        record[row[0]] = { code: row[1] || "", dayType: row[2] || "", memo: row[3] || "" };
      }
    });
  return record;
}

// 対象月の行を入れ替えて、日付順に書き直す
function saveRecord(year, month, entries) {
  const sheet = getRecordSheet();
  const prefix = year + "-" + pad(month) + "-";
  const rows = sheet
    .getDataRange()
    .getDisplayValues()
    .slice(1)
    .filter((row) => row[0] && row[0].indexOf(prefix) !== 0)
    .map((row) => [row[0], row[1] || "", row[2] || "", row[3] || ""]);
  Object.keys(entries).forEach((key) => {
    const e = entries[key];
    rows.push([key, e.code, e.dayType, e.memo]);
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const lastRow = sheet.getLastRow();
  const width = RECORD_HEADER.length;
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  if (rows.length > 0) {
    const range = sheet.getRange(2, 1, rows.length, width);
    range.setNumberFormat("@");
    range.setValues(rows);
  }
}

// ---------- 日付 ----------

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

function dateKey(year, month, day) {
  return year + "-" + pad(month) + "-" + pad(day);
}

function toKey(date) {
  return dateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}
