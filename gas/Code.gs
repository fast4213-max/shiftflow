/**
 * shiftflow - GAS Web App
 *
 * このスクリプトは、登録先のスプレッドシートに紐づく「コンテナバインドスクリプト」
 * (スプレッドシートの「拡張機能」→「Apps Script」から作成)として使う前提。
 * そのためスプレッドシートID自体はスクリプトプロパティに持たず、
 * SpreadsheetApp.getActiveSpreadsheet() で自分自身を参照する。
 *
 * webapp から送られてきた勤務データ(日付・曜日・勤務コード)を受け取り、
 * 1. 「勤務コード」シートのマスタと突き合わせて出退勤時間を確定させる
 * 2. 「勤務記録」シートに書き込む
 * 3. 勤務用/休日用の2つのGoogleカレンダーに予定を登録する
 *
 * カレンダーIDはスクリプトプロパティ(「プロジェクトの設定」→「スクリプト プロパティ」)に設定する。
 *   - WORK_CALENDAR_ID
 *   - HOLIDAY_CALENDAR_ID
 *
 * 「勤務コード」シートの構成(1行目はヘッダー):
 *   勤務番号 | 勤務内容 | 出勤時間 | 退勤時間 | 休日フラグ(TRUE/FALSE, 任意)
 *
 * webapp側で日付ごとの勤務番号を選び直すと、このマスタを見て出退勤時間が自動で変わる。
 */

const MASTER_SHEET_NAME = "勤務コード";
const RECORD_SHEET_NAME = "勤務記録";

function doPost(e) {
  const payload = JSON.parse(e.postData.contents);
  const rows = payload.rows || [];
  const master = loadMaster();

  writeToSheet(rows, master);
  registerToCalendars(rows, master);

  return jsonOutput({ status: "ok", count: rows.length });
}

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === "master") {
    return jsonOutput({ master: loadMaster() });
  }
  return jsonOutput({ status: "ok" });
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// 「勤務コード」シートを読み込み、webapp側での選択・時間自動反映に使えるJSONにする
function loadMaster() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    MASTER_SHEET_NAME
  );
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  const body = values.slice(1); // ヘッダー行を除く

  return body
    .filter((row) => row[0] !== "" && row[0] !== null)
    .map((row) => ({
      code: String(row[0]),
      duty: row[1],
      startTime: row[2] ? formatTime(row[2]) : "",
      endTime: row[3] ? formatTime(row[3]) : "",
      isHoliday: row[4] === true || row[4] === "TRUE",
    }));
}

function formatTime(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, "Asia/Tokyo", "HH:mm");
  }
  return String(value);
}

function findMasterEntry(master, code) {
  return master.find((m) => m.code === String(code));
}

function getOrCreateRecordSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(RECORD_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(RECORD_SHEET_NAME);
    sheet.appendRow(["日付", "曜日", "勤務番号", "勤務内容", "出勤時間", "退勤時間"]);
  }
  return sheet;
}

function writeToSheet(rows, master) {
  const sheet = getOrCreateRecordSheet();

  rows.forEach((row) => {
    const entry = findMasterEntry(master, row.duty);
    sheet.appendRow([
      row.date,
      row.weekday,
      row.duty,
      entry ? entry.duty : "",
      entry ? entry.startTime : "",
      entry ? entry.endTime : "",
    ]);
  });
}

function registerToCalendars(rows, master) {
  const props = PropertiesService.getScriptProperties();
  const workCalendar = CalendarApp.getCalendarById(
    props.getProperty("WORK_CALENDAR_ID")
  );
  const holidayCalendar = CalendarApp.getCalendarById(
    props.getProperty("HOLIDAY_CALENDAR_ID")
  );

  rows.forEach((row) => {
    const entry = findMasterEntry(master, row.duty);
    const date = parseDate(row.date);
    const holiday = entry ? entry.isHoliday : row.duty.indexOf("休") !== -1;
    const calendar = holiday ? holidayCalendar : workCalendar;
    const title = entry ? entry.duty : row.duty;

    // 同じ日にすでに登録済みの予定があれば重複させないよう削除してから登録し直す
    calendar.getEventsForDay(date).forEach((event) => event.deleteEvent());

    if (entry && entry.startTime && entry.endTime) {
      const start = combineDateAndTime(date, entry.startTime);
      const end = combineDateAndTime(date, entry.endTime);
      calendar.createEvent(title, start, end);
    } else {
      calendar.createAllDayEvent(title, date);
    }
  });
}

function combineDateAndTime(date, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

// "9/1" のような月/日の文字列を、今日から見て一番近い未来寄りの年のDateに変換する
// (年末年始をまたぐ勤務表でも自然な年になるようにするため)
function parseDate(monthDaySlash) {
  const [month, day] = monthDaySlash.split("/").map(Number);
  const today = new Date();
  const year = today.getFullYear();

  let candidate = new Date(year, month - 1, day);
  const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6;
  if (candidate.getTime() < today.getTime() - sixMonthsMs) {
    candidate = new Date(year + 1, month - 1, day);
  }

  return candidate;
}
