// アプリ内カレンダーの勤務の予定の組み立てのテスト(Google への通信は無い)
//   deno test supabase/functions --allow-read --allow-env

import { assertEquals } from "jsr:@std/assert@1";
import { indexMaster } from "./plan.js";
import { buildShiftView, buildShiftViewWithCarry, monthsBetween, validIso } from "./shift-view.ts";

const master = indexMaster([
  { code: "25", kind: "日勤", weekday_start: "10:15", weekday_end: "19:02", holiday_start: "", holiday_end: "", stay: "" },
  { code: "5", kind: "泊", weekday_start: "10:00", weekday_end: "9:00", holiday_start: "", holiday_end: "", stay: "大阪" },
  { code: "公休", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "" },
]);

const view = (records: Record<string, { code: string; memo: string }>, settings: Record<string, boolean> = {}, months = [{ year: 2026, month: 10 }]) =>
  buildShiftView({ months, records, master, holidays: [], settings }).map((e) => [e.date, e.endDate, e.calendar, e.title, e.startTime, e.endTime]);

Deno.test("buildShiftView: ふつうの設定は、終日の予定(番号・非番の「〜」・休日)", () => {
  assertEquals(
    view({ "2026-10-05": { code: "25", memo: "" }, "2026-10-11": { code: "5", memo: "" }, "2026-10-14": { code: "公休", memo: "" } }),
    [
      ["2026-10-05", "2026-10-05", "work", "25", "", ""],
      ["2026-10-11", "2026-10-11", "work", "5", "", ""],
      ["2026-10-12", "2026-10-12", "work", "〜", "", ""],
      ["2026-10-14", "2026-10-14", "holiday", "公休", "", ""],
    ],
  );
});

Deno.test("buildShiftView: 名前に時間を付ける設定なら、Google に入るのと同じ名前になる", () => {
  assertEquals(
    view({ "2026-10-05": { code: "25", memo: "" }, "2026-10-11": { code: "5", memo: "" } }, { titleDayTime: true, titleOffdutyTime: true }).map((r) => r[3]),
    ["25(10:15)", "5(10:00)", "〜(9:00)"],
  );
});

Deno.test("buildShiftView: 出勤・非番を2件にする設定でも、アプリ内では1本にまとめる(名前のあとに時間。二重に見えないように)", () => {
  const out = view({ "2026-10-05": { code: "25", memo: "" }, "2026-10-11": { code: "5", memo: "" } }, { splitDayEvents: true, splitOffdutyEvents: true });
  assertEquals(out.map((r) => [r[0], r[3], r[4]]), [
    ["2026-10-05", "25 10:15〜19:02", ""],
    ["2026-10-11", "5 10:00", ""],
    ["2026-10-12", "〜 9:00", ""],
  ]);
  // 名前に時間がもう付いている(「名前に時間」の設定)ときは、続けない
  const both = view({ "2026-10-11": { code: "5", memo: "" } }, { splitDayEvents: true, splitOffdutyEvents: true, titleDayTime: true, titleOffdutyTime: true });
  assertEquals(both.map((r) => r[3]), ["5(10:00)", "〜(9:00)"]);
});

Deno.test("buildShiftView: 時間つきの設定なら、泊は出勤から翌日の退勤までの1件(日をまたぐ)・日勤は出勤〜退勤", () => {
  assertEquals(
    view({ "2026-10-05": { code: "25", memo: "" }, "2026-10-11": { code: "5", memo: "" } }, { timedEvents: true }),
    [
      ["2026-10-05", "2026-10-05", "work", "25", "10:15", "19:02"],
      ["2026-10-11", "2026-10-12", "work", "5", "10:00", "09:00"],
    ],
  );
});

Deno.test("buildShiftView: 月末の泊は翌月1日の予定を、その月ではなく翌月に出す(2か月続けても二重にならない)", () => {
  const records = { "2026-10-31": { code: "5", memo: "" } };
  const both = view(records, {}, [{ year: 2026, month: 10 }, { year: 2026, month: 11 }]);
  assertEquals(both, [
    ["2026-10-31", "2026-10-31", "work", "5", "", ""],
    ["2026-11-01", "2026-11-01", "work", "〜", "", ""],
  ]);
  // 10月だけ見たときは、11月1日は出ない
  assertEquals(view(records), [["2026-10-31", "2026-10-31", "work", "5", "", ""]]);
});

Deno.test("buildShiftView: 時間つきで月末の泊は翌月1日の朝まで1件。翌月1日の「〜」は二重に出さない", () => {
  const records = { "2026-10-31": { code: "5", memo: "" } };
  const out = view(records, { timedEvents: true }, [{ year: 2026, month: 10 }, { year: 2026, month: 11 }]);
  assertEquals(out, [["2026-10-31", "2026-11-01", "work", "5", "10:00", "09:00"]]);
});

Deno.test("buildShiftView: 前の月の月末の泊から続く1日の非番は、その月の最初に出る(記録だけ前の月末にある)", () => {
  assertEquals(
    view({ "2026-09-30": { code: "5", memo: "" } }),
    [["2026-10-01", "2026-10-01", "work", "〜", "", ""]],
  );
});

// M6: 前の月の末日が泊で、時間つきの設定のとき、範囲の最初の月(11月)だけを組み立てると、1日に余計な「〜」が出て泊の続きが出ない。
// 前の月から組み立てて、前の月の末日からの分だけ残す
const viewCarry = (records: Record<string, { code: string; memo: string }>, settings: Record<string, boolean>, months: { year: number; month: number }[]) =>
  buildShiftViewWithCarry({ months, records, master, holidays: [], settings }).map((e) => [e.date, e.endDate, e.calendar, e.title, e.startTime, e.endTime]);

Deno.test("buildShiftViewWithCarry: 時間つきの設定で、月末の泊は翌月1日の朝までの1件(範囲が翌月から始まっても、1日に「〜」を出さない)", () => {
  const records = { "2026-10-31": { code: "5", memo: "" } };
  assertEquals(viewCarry(records, { timedEvents: true }, [{ year: 2026, month: 11 }]), [["2026-10-31", "2026-11-01", "work", "5", "10:00", "09:00"]]);
  // 前の月から組み立てない今までの方法だと、余計な「〜」が出る(これが直した問題)
  assertEquals(view(records, { timedEvents: true }, [{ year: 2026, month: 11 }]), [["2026-11-01", "2026-11-01", "work", "〜", "", ""]]);
});

Deno.test("buildShiftViewWithCarry: ふつうの設定は今までと同じ(月末の泊と、翌月1日の「〜」)。前の月の末日より前の予定は残さない", () => {
  const records = { "2026-10-30": { code: "25", memo: "" }, "2026-10-31": { code: "5", memo: "" } };
  assertEquals(viewCarry(records, {}, [{ year: 2026, month: 11 }]), [
    ["2026-10-31", "2026-10-31", "work", "5", "", ""],
    ["2026-11-01", "2026-11-01", "work", "〜", "", ""],
  ]);
});

Deno.test("buildShiftViewWithCarry: 1月の範囲は前の年の12月から続ける", () => {
  const records = { "2026-12-31": { code: "5", memo: "" } };
  assertEquals(viewCarry(records, { timedEvents: true }, [{ year: 2027, month: 1 }]), [["2026-12-31", "2027-01-01", "work", "5", "10:00", "09:00"]]);
});

Deno.test("validIso: 実在する日付だけ通す", () => {
  for (const ok of ["2026-11-03", "2028-02-29", "2000-01-01"]) assertEquals(validIso(ok), true, ok);
  for (const bad of ["2026-13-45", "2026-02-30", "2027-02-29", "2026-00-10", "2026-11-00", "1999-12-31", "2101-01-01", "2026-1-1", "abc", ""]) assertEquals(validIso(bad), false, bad);
});

Deno.test("monthsBetween: 範囲にかかる月を、古い順に(年をまたぐ)", () => {
  assertEquals(monthsBetween("2026-12-27", "2027-02-06"), [{ year: 2026, month: 12 }, { year: 2027, month: 1 }, { year: 2027, month: 2 }]);
  assertEquals(monthsBetween("2026-11-01", "2026-11-30"), [{ year: 2026, month: 11 }]);
});
