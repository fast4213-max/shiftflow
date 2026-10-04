// 予定の組み立てのテスト
//   deno test supabase/functions --allow-read

import { assertEquals } from "jsr:@std/assert@1";
import { buildPlan, dayTypeOf, indexMaster } from "./plan.js";

// 架空のマスタ
const master = indexMaster([
  { code: "101", kind: "泊", weekday_start: "9:00", weekday_end: "9:30", holiday_start: "9:10", holiday_end: "9:40", stay: "泊地A" },
  { code: "102", kind: "泊", weekday_start: "10:00", weekday_end: "8:45", holiday_start: "", holiday_end: "", stay: "" },
  {
    code: "103", kind: "泊", weekday_start: "10:04", weekday_end: "9:31", holiday_start: "9:56", holiday_end: "5:54",
    weekday_holiday_start: "10:30", weekday_holiday_end: "9:52", holiday_weekday_start: "9:40", holiday_weekday_end: "9:20",
    stay: "",
  },
  // 日勤に平休・休平の列があっても使わない(泊だけの列)
  {
    code: "203", kind: "日勤", weekday_start: "8:30", weekday_end: "17:15", holiday_start: "9:00", holiday_end: "17:00",
    weekday_holiday_start: "7:00", weekday_holiday_end: "7:30", holiday_weekday_start: "7:00", holiday_weekday_end: "7:30", stay: "",
  },
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

// 非番の日の退勤(泊の日の平休 → 非番の日の平休)
function offduty(p: { events: { kind: string; date: string; description: string }[] }) {
  return p.events.filter((e) => e.kind === "offduty").map((e) => e.date + " " + e.description);
}

Deno.test("非番の退勤: 平→平は平日退勤、休→休は休日退勤", () => {
  assertEquals(offduty(plan(2026, 10, { "2026-10-05": { code: "103" } })), ["2026-10-06 9:31"]); // 月→火
  assertEquals(offduty(plan(2026, 10, { "2026-10-03": { code: "103" } })), ["2026-10-04 5:54"]); // 土→日
});

Deno.test("非番の退勤: 平→休は平休退勤、休→平は休平退勤", () => {
  assertEquals(offduty(plan(2026, 10, { "2026-10-02": { code: "103" } })), ["2026-10-03 9:52"]); // 金→土
  assertEquals(offduty(plan(2026, 10, { "2026-10-04": { code: "103" } })), ["2026-10-05 9:20"]); // 日→月
  // 祝日・年末年始も休日として見る
  assertEquals(offduty(plan(2026, 10, { "2026-10-11": { code: "103" } }, { holidays: ["2026-10-12"] })), ["2026-10-12 5:54"]); // 日→祝
  assertEquals(offduty(plan(2026, 10, { "2026-10-12": { code: "103" } }, { holidays: ["2026-10-12"] })), ["2026-10-13 9:20"]); // 祝→火
  assertEquals(offduty(plan(2026, 12, { "2026-12-29": { code: "103" } })), ["2026-12-30 9:52"]); // 火→年末
  assertEquals(offduty(plan(2026, 12, { "2026-12-31": { code: "103" } })), ["2027-01-01 5:54"]); // 年末→元日
});

Deno.test("非番の退勤: 平休退勤・休平退勤が空(列の無いマスタ)なら今までどおり非番の日の列", () => {
  assertEquals(offduty(plan(2026, 10, { "2026-10-02": { code: "101" } })), ["2026-10-03 9:40"]); // 金→土: 休日退勤
  assertEquals(offduty(plan(2026, 10, { "2026-10-04": { code: "101" } })), ["2026-10-05 9:30"]); // 日→月: 平日退勤
  assertEquals(offduty(plan(2026, 10, { "2026-10-02": { code: "102" } })), ["2026-10-03 8:45"]); // 休日退勤も空なら平日退勤
});

Deno.test("非番の退勤: 月またぎも泊の日の平休を見る(前月末の祝日も)", () => {
  // 2029-04-30(月)は振替休日 → 5/1(火)の非番は休平退勤。祝日を知らなければ平日扱い
  assertEquals(offduty(plan(2029, 5, {}, { prevLastCode: "103", holidays: ["2029-04-30"] })), ["2029-05-01 9:20"]);
  assertEquals(offduty(plan(2029, 5, {}, { prevLastCode: "103" })), ["2029-05-01 9:31"]);
  // 月末が泊: 2027-01-31(日)→ 2/1(月)は休平退勤、2026-10-30(金)→ 31(土)は平休退勤
  assertEquals(offduty(plan(2027, 1, { "2027-01-31": { code: "103" } })), ["2027-02-01 9:20"]);
  assertEquals(offduty(plan(2026, 10, { "2026-10-30": { code: "103" } })), ["2026-10-31 9:52"]);
});

// 出勤の日のメモ(1行目)
function duty(p: { events: { kind: string; date: string; description: string }[] }) {
  return p.events.filter((e) => e.kind === "day").map((e) => e.date + " " + e.description);
}

Deno.test("泊の出勤: 平→平は平日出勤、休→休は休日出勤、平→休は平休出勤、休→平は休平出勤", () => {
  assertEquals(duty(plan(2026, 10, { "2026-10-05": { code: "103" } })), ["2026-10-05 10:04"]); // 月→火
  assertEquals(duty(plan(2026, 10, { "2026-10-03": { code: "103" } })), ["2026-10-03 9:56"]); // 土→日
  assertEquals(duty(plan(2026, 10, { "2026-10-02": { code: "103" } })), ["2026-10-02 10:30"]); // 金→土
  assertEquals(duty(plan(2026, 10, { "2026-10-04": { code: "103" } })), ["2026-10-04 9:40"]); // 日→月
  // 翌日が祝日・年末年始
  assertEquals(duty(plan(2026, 10, { "2026-10-11": { code: "103" } }, { holidays: ["2026-10-12"] })), ["2026-10-11 9:56"]); // 日→祝
  assertEquals(duty(plan(2026, 10, { "2026-10-09": { code: "103" } }, { holidays: ["2026-10-12"] })), ["2026-10-09 10:30"]); // 金→土
  assertEquals(duty(plan(2026, 12, { "2026-12-29": { code: "103" } })), ["2026-12-29 10:30"]); // 火→年末
});

Deno.test("泊の出勤: 平休出勤・休平出勤が空(列の無いマスタ)なら今までどおり泊の日の列", () => {
  assertEquals(duty(plan(2026, 10, { "2026-10-02": { code: "101" } })), ["2026-10-02 9:00\n泊地A"]); // 金→土: 平日出勤
  assertEquals(duty(plan(2026, 10, { "2026-10-04": { code: "101" } })), ["2026-10-04 9:10\n泊地A"]); // 日→月: 休日出勤
  assertEquals(duty(plan(2026, 10, { "2026-10-04": { code: "102" } })), ["2026-10-04 10:00"]); // 休日出勤も空なら平日出勤
});

Deno.test("日勤は平休・休平の列を使わない", () => {
  assertEquals(duty(plan(2026, 10, { "2026-10-02": { code: "203" }, "2026-10-04": { code: "203" } })), [
    "2026-10-02 8:30〜17:15",
    "2026-10-04 9:00〜17:00",
  ]);
});

Deno.test("泊の出勤: 月末・翌月1日の泊も翌日の平休を見る", () => {
  assertEquals(duty(plan(2026, 10, { "2026-10-30": { code: "103" } })), ["2026-10-30 10:30"]); // 金→土
  // 翌月1日の記録の予定: 2026-11-01(日)→ 2(月)は休平出勤
  assertEquals(duty(plan(2026, 10, {}, { nextFirstEntry: { code: "103", memo: "" } })), ["2026-11-01 9:40"]);
});

Deno.test("休日だけの番号(平日の時刻が空): 休日は休日の時間、平日はメモの時間なし", () => {
  const m = indexMaster([
    { code: "5742", kind: "日勤", weekday_start: "", weekday_end: "", holiday_start: "8:15", holiday_end: "16:00", stay: "" },
  ]);
  const p = buildPlan({
    year: 2026, month: 10, prevLastCode: "", nextFirstEntry: null, master: m, holidays: [],
    entries: { "2026-10-03": { code: "5742" }, "2026-10-05": { code: "5742" } },
  });
  assertEquals(p.events, [
    { date: "2026-10-03", calendar: "work", kind: "day", title: "5742", description: "8:15〜16:00" },
    { date: "2026-10-05", calendar: "work", kind: "day", title: "5742", description: "" },
  ]);
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
