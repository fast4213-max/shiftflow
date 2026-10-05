// マスタの CSV 取り込み前のチェック(web/js/csv.js)のテスト
//   deno test supabase/functions --allow-read

import { assertEquals } from "jsr:@std/assert@1";
import { checkMasterRows, masterRowsFromCsv } from "../../../web/js/csv.js";

const HEADER = "番号,種別,平日出勤,平日退勤,休日出勤,休日退勤,泊,平休出勤,平休退勤,休平出勤,休平退勤";

function check(lines: string[]) {
  return checkMasterRows(masterRowsFromCsv([HEADER, ...lines].join("\n")));
}

Deno.test("CSV: 問題のない行は OK。平休・休平の列は無くてもよい", () => {
  const rows = check(["18,泊,10:04,9:31,9:56,5:54,日根野,,9:52,,", "1,日勤,6:16,14:09,6:18,13:52,,,,,", "公休,休日,,,,,,,,,"]);
  assertEquals(rows.map((r: { errors: string[] }) => r.errors), [[], [], []]);
  assertEquals(rows[0].weekday_holiday_end, "9:52");
  const old = checkMasterRows(masterRowsFromCsv("番号,種別,平日出勤,平日退勤,休日出勤,休日退勤,泊\n11,泊,10:49,10:45,10:49,10:51,日根野"));
  assertEquals(old[0].errors, []);
  assertEquals(old[0].weekday_holiday_end, "");
});

Deno.test("CSV: 番号だけ空の行は「番号が空」。全部空の行は無視", () => {
  const rows = check([",日勤,6:00,14:00,,,,,,,", ",,,,,,,,,,", "2,日勤,6:11,13:09,,,,,,,"]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].errors, ["番号が空"]);
  assertEquals(rows[1].errors, []);
});

Deno.test("CSV: 日勤・休日の行に平休・休平の時刻があればエラー(泊だけで使う)", () => {
  const rows = check(["1,日勤,6:16,14:09,6:18,13:52,,6:00,,,", "公休,休日,,,,,,,,,9:00", "18,泊,10:04,9:31,9:56,5:54,,10:04,9:52,,"]);
  assertEquals(rows.map((r: { errors: string[] }) => r.errors), [["平休・休平の時刻は泊だけ"], ["平休・休平の時刻は泊だけ"], []]);
});

Deno.test("CSV: 時刻の欄の記号だけ(-・－・×など)は空。「〃」や文字は読めないエラー", () => {
  const rows = check(["5742,日勤,-,－,8:15,16:00,,,,,", "5741,日勤,9:01,16:41,×,―,,,,,", "7,日勤,〃,14:00,,,,,,,", "8,日勤,9時,14:00,,,,,,,"]);
  assertEquals(rows[0].errors, []);
  assertEquals([rows[0].weekday_start, rows[0].weekday_end, rows[0].holiday_start], ["", "", "8:15"]);
  assertEquals(rows[1].errors, []);
  assertEquals([rows[1].holiday_start, rows[1].holiday_end], ["", ""]);
  assertEquals(rows[2].errors, ["時刻が読めない: 〃"]);
  assertEquals(rows[3].errors, ["時刻が読めない: 9時"]);
});

Deno.test("CSV: 泊・日勤で平日出勤と休日出勤がどちらも空ならエラー(休日だけの番号は OK)", () => {
  const rows = check(["5742,日勤,,,8:15,16:00,,,,,", "9,日勤,-,-,-,-,,,,,"]);
  assertEquals(rows.map((r: { errors: string[] }) => r.errors), [[], ["出勤が空(平日・休日とも)"]]);
});


Deno.test("CSV: 番号が constructor・__proto__ でも重複を数えられる", () => {
  const rows = check(["constructor,日勤,6:00,14:00,,,,,,,", "constructor,日勤,6:00,14:00,,,,,,,", "__proto__,日勤,6:00,14:00,,,,,,,"]);
  assertEquals(rows.map((r: { errors: string[] }) => r.errors), [["番号が重複"], ["番号が重複"], []]);
});

Deno.test("CSV: 番号の全角の英数字・記号は半角にそろえる(日本語はそのまま)。全角と半角の重複も見つかる", () => {
  const rows = check(["１０１,泊,9:00,9:30,,,,,,,", "101,泊,9:00,9:30,,,,,,,", "変７ｄ,日勤,9:00,17:45,,,,,,,", "Ａ１　,日勤,9:00,17:45,,,,,,,", "公休,休日,,,,,,,,,"]);
  assertEquals(rows.map((r: { code: string }) => r.code), ["101", "101", "変7d", "A1", "公休"]);
  assertEquals(rows.map((r: { errors: string[] }) => r.errors), [["番号が重複"], ["番号が重複"], [], [], []]);
});

