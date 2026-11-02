// アプリ内カレンダーの勤務の予定の組み立てのテスト(Google への通信は無い)
//   deno test supabase/functions --allow-read --allow-env

import { assertEquals } from "jsr:@std/assert@1";
import { indexMaster } from "./plan.js";
import { buildShiftView } from "./shift-view.ts";

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

Deno.test("buildShiftView: 出勤・非番を2件にする設定なら、時間の予定が1件ずつ付く(分単位)", () => {
  const out = view({ "2026-10-05": { code: "25", memo: "" } }, { splitDayEvents: true });
  assertEquals(out, [
    ["2026-10-05", "2026-10-05", "work", "25", "", ""],
    // 2件目は、Google に入るのと同じ(題名は出勤〜退勤の時間・時間は出勤から退勤まで)
    ["2026-10-05", "2026-10-05", "work", "10:15〜19:02", "10:15", "19:02"],
  ]);
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
