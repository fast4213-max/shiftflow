// 予定の組み立てのテスト
//   deno test supabase/functions --allow-read

import { assertEquals } from "jsr:@std/assert@1";
import { buildPlan, dayTypeOf, holidayYearsFor, indexMaster, MasterSet, masterOn, periodLabel } from "./plan.js";

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

Deno.test("祝日の一覧が要る年: 年末年始にはみ出すだけの年は要らない(1月の登録が前の年を見ない)", () => {
  // 1月の登録: 前月末(前の年の12/31)〜翌月2日
  assertEquals(holidayYearsFor("2026-12-31", "2027-02-02"), [2027]);
  // 12月の登録: 11月末〜翌月2日(翌年の1/1・1/2)
  assertEquals(holidayYearsFor("2026-11-30", "2027-01-02"), [2026]);
  // 画面(前月末〜翌月1日)
  assertEquals(holidayYearsFor("2026-12-31", "2027-02-01"), [2027]);
  assertEquals(holidayYearsFor("2026-11-30", "2027-01-01"), [2026]);
  // 普通の月は、その年だけ。年をまたぐ範囲(12/29〜1/4)は両方
  assertEquals(holidayYearsFor("2026-09-30", "2026-11-02"), [2026]);
  assertEquals(holidayYearsFor("2026-12-29", "2027-01-04"), [2026, 2027]);
  // 年末年始の中だけ(12/30〜1/3)なら、祝日の一覧は要らない
  assertEquals(holidayYearsFor("2026-12-30", "2027-01-03"), []);
});

Deno.test("手入力の番号が constructor・toString・__proto__ などでも止まらず、手入力として扱う", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const p = plan(2026, 10, { "2026-10-05": { code: name, memo: "" } });
    assertEquals(p.events, [{ date: "2026-10-05", calendar: "work", kind: "day", title: name, description: "" }]);
  }
  // 前日の番号が constructor などでも、非番にならず止まらない
  assertEquals(plan(2026, 10, {}, { prevLastCode: "constructor" }).events, []);
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

Deno.test("翌休泊: 泊の翌日(非番の日)が休日なら翌休泊、平日なら泊。翌休泊が空なら今までどおり", () => {
  // 架空のマスタ(実データは書かない)
  const m = indexMaster([
    { code: "301", kind: "泊", weekday_start: "9:00", weekday_end: "9:30", holiday_start: "9:10", holiday_end: "9:40", stay: "泊地A", stay_next_holiday: "泊地B" },
    { code: "302", kind: "泊", weekday_start: "10:00", weekday_end: "8:45", holiday_start: "10:10", holiday_end: "8:55", stay: "泊地C" },
  ]);
  // 2026-10: 1(木) 2(金) 3(土) 4(日) 5(月) 12(祝)
  const p = buildPlan({
    year: 2026, month: 10, prevLastCode: "", nextFirstEntry: null, master: m, holidays: ["2026-10-12"],
    entries: {
      "2026-10-01": { code: "301", memo: "" }, // 翌日は平日の金曜
      "2026-10-08": { code: "301", memo: "" }, // 翌日は金曜
      "2026-10-09": { code: "301", memo: "" }, // 非番の日(番号は無視)
      "2026-10-16": { code: "301", memo: "" }, // 翌日は土曜
      "2026-10-11": { code: "301", memo: "変更" }, // 翌日は祝日。手で直したメモでも泊地は2行目
      "2026-10-23": { code: "302", memo: "" }, // 翌日は土曜でも、翌休泊が空なら泊
    },
  });
  const desc = (d: string) => p.events.find((e: { date: string }) => e.date === d)?.description;
  assertEquals(desc("2026-10-01"), "9:00\n泊地A");
  assertEquals(desc("2026-10-08"), "9:00\n泊地A");
  assertEquals(desc("2026-10-16"), "9:00\n泊地B");
  assertEquals(desc("2026-10-11"), "変更\n泊地B");
  assertEquals(desc("2026-10-23"), "10:00\n泊地C");
});

Deno.test("翌休泊: 月末の泊は、翌月1日の平休で選ぶ", () => {
  const m = indexMaster([
    { code: "303", kind: "泊", weekday_start: "12:00", weekday_end: "9:00", holiday_start: "11:00", holiday_end: "9:00", stay: "泊地D", stay_next_holiday: "泊地E" },
  ]);
  // 2026-10-31 は土曜、翌11-01 は日曜(休日)。2026-09-30 は水曜、翌10-01 は木曜(平日)
  const oct = buildPlan({ year: 2026, month: 10, prevLastCode: "", nextFirstEntry: null, master: m, holidays: [], entries: { "2026-10-31": { code: "303", memo: "" } } });
  assertEquals(oct.events.find((e: { date: string }) => e.date === "2026-10-31")?.description.split("\n")[1], "泊地E");
  const sep = buildPlan({ year: 2026, month: 9, prevLastCode: "", nextFirstEntry: null, master: m, holidays: [], entries: { "2026-09-30": { code: "303", memo: "" } } });
  assertEquals(sep.events.find((e: { date: string }) => e.date === "2026-09-30")?.description.split("\n")[1], "泊地D");
});

// ---------- マスタの切替(ダイヤ改正・ダイヤ修正) ----------
// 架空のマスタ(実データは書かない)。2026-11-14(土) から次のマスタ
const PERIODS = [
  { id: 1, starts_on: "2026-10-03", name: "ダイヤ修正" },
  { id: 2, starts_on: "2026-11-14", name: "ダイヤ改正" },
];
const OLD_ROWS = [
  { period_id: 1, code: "1", kind: "泊", weekday_start: "9:00", weekday_end: "9:30", holiday_start: "", holiday_end: "", stay: "泊地A" },
  { period_id: 1, code: "2", kind: "泊", weekday_start: "9:05", weekday_end: "9:35", holiday_start: "", holiday_end: "", stay: "" },
  { period_id: 1, code: "5", kind: "日勤", weekday_start: "8:00", weekday_end: "17:00", holiday_start: "", holiday_end: "", stay: "" },
];
const NEW_ROWS = [
  { period_id: 2, code: "1", kind: "泊", weekday_start: "10:00", weekday_end: "8:10", holiday_start: "", holiday_end: "8:20", stay: "泊地B" },
  { period_id: 2, code: "5", kind: "日勤", weekday_start: "7:00", weekday_end: "16:00", holiday_start: "7:30", holiday_end: "15:00", stay: "" },
];
const novPlan = (master: MasterSet, entries: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
  buildPlan({ year: 2026, month: 11, entries, prevLastCode: "", nextFirstEntry: null, master, holidays: [], ...opts });

Deno.test("切替: 切替日より前は前のマスタ、切替日からは新しいマスタ", () => {
  const set = new MasterSet(PERIODS, [...OLD_ROWS, ...NEW_ROWS]);
  const p = novPlan(set, { "2026-11-12": { code: "5", memo: "" }, "2026-11-16": { code: "5", memo: "" } });
  assertEquals(p.errors, []);
  assertEquals(p.events.map((e) => [e.date, e.description]), [["2026-11-12", "8:00〜17:00"], ["2026-11-16", "7:00〜16:00"]]);
  // いちばん古いマスタは、その切替日より前の日にも使う
  assertEquals(masterOn(set, "2026-09-01")["5"].start.平日, "8:00");
  assertEquals(set.periodOn("2026-11-13").name, "ダイヤ修正");
  assertEquals(set.periodOn("2026-11-14").name, "ダイヤ改正");
  assertEquals(periodLabel(set.periodOn("2026-11-14")), "2026年11月 ダイヤ改正");
  assertEquals(periodLabel({ from: "2027-03-14", name: "" }), "2027年3月14日からのマスタ");
});

Deno.test("切替: 切替日の前日の泊は、出勤・泊地が前のマスタ、非番の退勤が新しいマスタ", () => {
  const set = new MasterSet(PERIODS, [...OLD_ROWS, ...NEW_ROWS]);
  const p = novPlan(set, { "2026-11-13": { code: "1", memo: "" } }, { holidays: [] });
  assertEquals(p.errors, []);
  assertEquals(p.events.map((e) => [e.date, e.title, e.description]), [
    ["2026-11-13", "1", "9:00\n泊地A"],
    ["2026-11-14", "〜", "8:20"], // 14日は土曜(休日)なので、新しいマスタの休日退勤
  ]);
});

Deno.test("切替: 新しいマスタに同じ番号の泊が無ければエラー。非番のメモに退勤時間があれば通る", () => {
  const set = new MasterSet(PERIODS, [...OLD_ROWS, ...NEW_ROWS]);
  const p = novPlan(set, { "2026-11-13": { code: "2", memo: "" } });
  assertEquals(p.errors.length, 1);
  assertEquals(p.errors[0].date, "2026-11-13");
  assertEquals(p.errors[0].message.includes("2026年11月 ダイヤ改正(11/14〜)のマスタにありません"), true);
  assertEquals(p.events.find((e) => e.date === "2026-11-14")?.description, "");
  const ok = novPlan(set, { "2026-11-13": { code: "2", memo: "" }, "2026-11-14": { code: "", memo: "9:00" } });
  assertEquals(ok.errors, []);
  assertEquals(ok.events.find((e) => e.date === "2026-11-14")?.description, "9:00");
});

Deno.test("切替: 新しいマスタが未登録なら、前日の泊も、切替日から後の番号もエラー(メモがあっても)", () => {
  const set = new MasterSet(PERIODS, OLD_ROWS);
  assertEquals(set.missingOn("2026-11-13"), false);
  assertEquals(set.missingOn("2026-11-14"), true);
  const p = novPlan(set, {
    "2026-11-13": { code: "1", memo: "" },
    "2026-11-14": { code: "", memo: "9:00" },
    "2026-11-16": { code: "公休", memo: "" },
    "2026-11-12": { code: "5", memo: "" },
  });
  assertEquals(p.errors.map((e) => e.date), ["2026-11-13", "2026-11-16"]);
  assertEquals(p.errors[0].message.includes("まだ登録されていないため"), true);
  // 前日が日勤・番号の無い日だけなら、エラーにならない
  assertEquals(novPlan(set, { "2026-11-13": { code: "5", memo: "" }, "2026-11-20": { code: "", memo: "メモ" } }).errors, []);
});

Deno.test("切替: 月末の泊で翌月1日から新しいマスタ。翌月1日の非番は新しいマスタの退勤", () => {
  const set = new MasterSet([{ id: 1, starts_on: "2026-10-03", name: "" }, { id: 2, starts_on: "2026-12-01", name: "ダイヤ改正" }],
    [...OLD_ROWS, ...NEW_ROWS]);
  const p = novPlan(set, { "2026-11-30": { code: "1", memo: "" } });
  assertEquals(p.errors, []);
  assertEquals(p.events.find((e) => e.date === "2026-12-01")?.description, "8:10");
  const missing = novPlan(new MasterSet([{ id: 1, starts_on: "2026-10-03", name: "" }, { id: 2, starts_on: "2026-12-01", name: "" }], OLD_ROWS),
    { "2026-11-30": { code: "1", memo: "" } });
  assertEquals(missing.errors.map((e) => e.date), ["2026-11-30"]);
});

Deno.test("切替: 前の月の月末の泊(prevLastCode)は、前の月末のマスタで泊かを決める", () => {
  const set = new MasterSet([{ id: 1, starts_on: "2026-10-03", name: "" }, { id: 2, starts_on: "2026-11-01", name: "" }], [...OLD_ROWS, ...NEW_ROWS]);
  // 「2」は前のマスタだけにある泊。11/1 は新しいマスタに「2」が無いのでエラー(メモを書けば通る)
  assertEquals(novPlan(set, {}, { prevLastCode: "2" }).errors.map((e) => e.date), ["2026-10-31"]);
  assertEquals(novPlan(set, { "2026-11-01": { code: "", memo: "9:00" } }, { prevLastCode: "2" }).errors, []);
});
