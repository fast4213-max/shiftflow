/**
 * shiftflow - GAS Web App
 *
 * webapp から送られてきた勤務データ(日付・曜日・勤務内容)を受け取り、
 * 1. スプレッドシートに書き込む
 * 2. 勤務用/休日用の2つのGoogleカレンダーに予定を登録する
 *
 * 実際のスプレッドシートID・カレンダーIDは「プロジェクトの設定」の
 * スクリプトプロパティに設定すること(コードに直接書かない)。
 *   - SPREADSHEET_ID
 *   - WORK_CALENDAR_ID
 *   - HOLIDAY_CALENDAR_ID
 *
 * 勤務内容に「休」を含む場合は休日用カレンダー、それ以外は勤務用カレンダーに登録する。
 * 判定ロジックを変えたい場合は isHoliday() だけ調整すればよい。
 */

const SHEET_NAME = "勤務記録";

function doPost(e) {
  const payload = JSON.parse(e.postData.contents);
  const rows = payload.rows || [];

  writeToSheet(rows);
  registerToCalendars(rows);

  return ContentService.createTextOutput(
    JSON.stringify({ status: "ok", count: rows.length })
  ).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: "ok" })
  ).setMimeType(ContentService.MimeType.JSON);
}

function writeToSheet(rows) {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty("SPREADSHEET_ID");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow(["日付", "曜日", "勤務"]);
  }

  rows.forEach((row) => {
    sheet.appendRow([row.date, row.weekday, row.duty]);
  });
}

function registerToCalendars(rows) {
  const props = PropertiesService.getScriptProperties();
  const workCalendar = CalendarApp.getCalendarById(
    props.getProperty("WORK_CALENDAR_ID")
  );
  const holidayCalendar = CalendarApp.getCalendarById(
    props.getProperty("HOLIDAY_CALENDAR_ID")
  );

  rows.forEach((row) => {
    const date = parseDate(row.date);
    const calendar = isHoliday(row.duty) ? holidayCalendar : workCalendar;

    // 同じ日にすでに登録済みの予定があれば重複させないよう削除してから登録し直す
    calendar
      .getEventsForDay(date)
      .forEach((event) => event.deleteEvent());

    calendar.createAllDayEvent(row.duty, date);
  });
}

function isHoliday(duty) {
  return duty.indexOf("休") !== -1;
}

// "9/1" のような月/日の文字列を、今日から見て一番近い未来寄りの年のDateに変換する
// (年末年始をまたぐ勤務表でも自然な年になるようにするため)
function parseDate(monthDaySlash) {
  const [month, day] = monthDaySlash.split("/").map(Number);
  const today = new Date();
  let year = today.getFullYear();

  let candidate = new Date(year, month - 1, day);
  const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6;
  if (candidate.getTime() < today.getTime() - sixMonthsMs) {
    candidate = new Date(year + 1, month - 1, day);
  }

  return candidate;
}
