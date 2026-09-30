// 予定の組み立てのテスト
//   deno test supabase/functions --allow-read

import { assertEquals } from "jsr:@std/assert@1";
import { buildPlan, dayTypeOf, indexMaster } from "./plan.js";

// 架空のマスタ
const master = indexMaster([
  { code: "101", kind: "泊", weekday_start: "9:00", weekday_end: "9:30", holiday_start: "9:10", holiday_end: "9:40", stay: "泊地A" },
  { code: "102", kind: "泊", weekday_start: "10:00", weekday_end: "8:45", holiday_start: "", holiday_end: "", stay: "" },
  { code: "201", kind: "日勤", weekday_start: "8:30", weekday_end: "17:15", holiday_start: "9:00", holiday_end: "17:00", stay: "" },
  { code: "公休", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "" },
]);

function plan(year: number, month: number, entries: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  return buildPlan({ year, month, entries, prevLastCode: "", nextFirstEntry: null, master, holidays: [], ...opts });
}

Deno.test("平休: 土日・祝日・年末年始は休日", () => {
  assertEquals(dayTypeOf("2026-10-05", []), "平日"); // 月
  assertEquals(dayTypeOf("2026-10-03", []), "休日"); // 土
  assertEquals(dayTypeOf("2026-10-04", []), "休日"); // 日
  assertEquals(dayTypeOf("2026-10-12", ["2026-10-12"]), "休日"); // 祝日
  assertEquals(dayTypeOf("2026-10-12", new Set(["2026-10-12"])), "休日");
  assertEquals(dayTypeOf("2026-12-29", []), "平日"); // 火
  assertEquals(dayTypeOf("2026-12-30", []), "休日");
  assertEquals(dayTypeOf("2027-01-04", []), "平日"); // 月
  assertEquals(dayTypeOf("2027-01-03", []), "休日");
});

Deno.test("泊: メモは出勤時間、2行目に泊地。翌日は非番(〜)で退勤時間", () => {
  const p = plan(2026, 10, { "2026-10-05": { code: "101" }, "2026-10-06": { code: "201" } });
  assertEquals(p.events, [
    { date: "2026-10-05", calendar: "work", kind: "day", title: "101", description: "9:00\n泊地A" },
    { date: "2026-10-06", calendar: "work", kind: "offduty", title: "〜", description: "9:30" },
  ]);
  // 非番の日に入っていた番号は捨てる
  assertEquals(p.entries, { "2026-10-05": { code: "101", memo: "" } });
});

Deno.test("泊地が空なら時間だけ", () => {
  const p = plan(2026, 10, { "2026-10-05": { code: "102" } });
  assertEquals(p.events[0].description, "10:00");
});

Deno.test("日勤: 出勤〜退勤。休の日は休日の列", () => {
  const p = plan(2026, 10, { "2026-10-05": { code: "201" }, "2026-10-03": { code: "201" } });
  assertEquals(p.events.map((e: { description: string }) => e.description), ["9:00〜17:00", "8:30〜17:15"]);
});

Deno.test("休日の時間が空なら平日の列にフォールバック", () => {
  const p = plan(2026, 10, { "2026-10-03": { code: "102" } }); // 土
  assertEquals(p.events[0].description, "10:00");
  assertEquals(p.events[1], { date: "2026-10-04", calendar: "work", kind: "offduty", title: "〜", description: "8:45" });
});

Deno.test("休日: 休日用カレンダー、メモなし(手で書けば入る)", () => {
  const p = plan(2026, 10, { "2026-10-05": { code: "公休" }, "2026-10-06": { code: "公休", memo: "旅行" } });
  assertEquals(p.events, [
    { date: "2026-10-05", calendar: "holiday", kind: "day", title: "公休", description: "" },
    { date: "2026-10-06", calendar: "holiday", kind: "day", title: "公休", description: "旅行" },
  ]);
});

Deno.test("手入力: 入力文字がタイトル、メモなし。空白だけは無視", () => {
  const p = plan(2026, 10, { "2026-10-05": { code: "変7d" }, "2026-10-06": { code: " " } });
  assertEquals(p.events, [{ date: "2026-10-05", calendar: "work", kind: "day", title: "変7d", description: "" }]);
  assertEquals(Object.keys(p.entries), ["2026-10-05"]);
});

Deno.test("手修正メモ: 1行目が置き換わり、泊地は残る。非番のメモも手修正できる", () => {
  const p = plan(2026, 10, {
    "2026-10-05": { code: "101", memo: "8:00" },
    "2026-10-06": { code: "", memo: "10:00" },
  });
  assertEquals(p.events[0].description, "8:00\n泊地A");
  assertEquals(p.events[1].description, "10:00");
  assertEquals((p.entries as Record<string, unknown>)["2026-10-06"], { code: "", memo: "10:00" });
});

Deno.test("月初: 前月末が泊なら1日は非番", () => {
  const p = plan(2026, 11, {}, { prevLastCode: "101" });
  assertEquals(p.events, [{ date: "2026-11-01", calendar: "work", kind: "offduty", title: "〜", description: "9:40" }]);
});

Deno.test("月末が泊なら翌月1日の非番も作る(翌月1日の手修正メモを使う)", () => {
  const p = plan(2026, 10, { "2026-10-31": { code: "101" } }, { nextFirstEntry: { code: "", memo: "11:11" } });
  assertEquals(p.events[1], { date: "2026-11-01", calendar: "work", kind: "offduty", title: "〜", description: "11:11" });
  assertEquals(Object.keys(p.entries), ["2026-10-31"]);
});

Deno.test("非番の日に番号が残っていたら、そのメモは非番のメモに使わない(前月末を泊にしたときの翌月1日など)", () => {
  const p = plan(2026, 10, { "2026-10-31": { code: "101" } }, { nextFirstEntry: { code: "201", memo: "早出" } });
  assertEquals(p.events[1], { date: "2026-11-01", calendar: "work", kind: "offduty", title: "〜", description: "9:40" });
  const m = plan(2026, 11, { "2026-11-01": { code: "201", memo: "早出" } }, { prevLastCode: "101" });
  assertEquals(m.events, [{ date: "2026-11-01", calendar: "work", kind: "offduty", title: "〜", description: "9:40" }]);
  assertEquals(m.entries, {});
});

Deno.test("12月末が泊なら翌年1月1日の非番(年末年始なので休日の列)", () => {
  const p = plan(2026, 12, { "2026-12-31": { code: "101" } });
  assertEquals(p.events[1], { date: "2027-01-01", calendar: "work", kind: "offduty", title: "〜", description: "9:40" });
});

Deno.test("月末が泊でなければ、翌月1日の記録の予定を作り直す(泊から戻したとき1日が空にならないように)", () => {
  const p = plan(2026, 10, { "2026-10-31": { code: "201" } }, { nextFirstEntry: { code: "201", memo: "" } });
  assertEquals(p.events[1], { date: "2026-11-01", calendar: "work", kind: "day", title: "201", description: "9:00〜17:00" });
  const h = plan(2026, 10, {}, { nextFirstEntry: { code: "公休", memo: "" } });
  assertEquals(h.events, [{ date: "2026-11-01", calendar: "holiday", kind: "day", title: "公休", description: "" }]);
  // 翌月1日は記録には入れない(翌月の分なので)
  assertEquals(Object.keys(p.entries), ["2026-10-31"]);
  assertEquals(h.entries, {});
});

Deno.test("メモだけの日は記録に残すが予定は作らない", () => {
  const p = plan(2026, 10, { "2026-10-05": { code: "", memo: "メモ" } });
  assertEquals(p.events, []);
  assertEquals(p.entries, { "2026-10-05": { code: "", memo: "メモ" } });
});

Deno.test("web/js/plan.js は _shared/plan.js と同じ内容", async () => {
  const shared = await Deno.readTextFile(new URL("./plan.js", import.meta.url));
  const web = await Deno.readTextFile(new URL("../../../web/js/plan.js", import.meta.url));
  assertEquals(web, shared);
});
