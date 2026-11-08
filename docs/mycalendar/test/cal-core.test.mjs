// node --test docs/mycalendar/test/cal-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, addMonths, addMonthsIso, announceItems, ANNOUNCE_MAX, resolveCalView, compareForDay, datesText, oldestDate, photosClosed, diffDays, expandEvent, gridRange, layoutWeek, monthLimits, shiftSpan, textOn, todayJst, weekday, whenText, yearsText,
} from "../../../web/calendar/cal-core.js";

test("日付の計算は月・年をまたぐ", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(diffDays("2026-10-31", "2026-11-02"), 2);
  assert.equal(weekday("2026-11-02"), 1); // 月曜
  assert.deepEqual(addMonths(2026, 11, 2), { y: 2027, m: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { y: 2025, m: 12 });
});

test("日本の今日は、UTCの夜でも日本の日付", () => {
  assert.equal(todayJst(Date.UTC(2026, 10, 1, 16, 0, 0)), "2026-11-02"); // UTC 16:00 = 日本 翌日 1:00
});

test("月の画面は、日曜はじまりで前後の月の日を含む", () => {
  const g = gridRange(2026, 11); // 2026-11-01 は日曜、11/30 は月曜
  assert.equal(g.from, "2026-11-01");
  assert.equal(g.to, "2026-12-05");
  const h = gridRange(2026, 10); // 10/1 は木曜
  assert.equal(h.from, "2026-09-27");
  assert.equal(h.to, "2026-10-31");
});

test("見られる月の範囲は、12か月前〜来年12月", () => {
  assert.deepEqual(monthLimits("2026-11-02"), { min: { y: 2025, m: 11 }, max: { y: 2027, m: 12 } });
});

test("繰り返し: 毎週・毎日・毎月(月末に寄せる)・毎年(うるう日)・終了日・この回だけ消した日", () => {
  const weekly = { id: "a", start: "2026-11-02", end: "2026-11-02", repeat: "weekly", until: "2026-11-20", exdates: ["2026-11-09"] };
  assert.deepEqual(expandEvent(weekly, "2026-11-01", "2026-12-31").map((o) => o.occ), ["2026-11-02", "2026-11-16"]);
  const daily = { id: "d", start: "2026-11-01", end: "2026-11-02", repeat: "daily" };
  assert.deepEqual(expandEvent(daily, "2026-11-10", "2026-11-11").map((o) => [o.start, o.end]), [["2026-11-09", "2026-11-10"], ["2026-11-10", "2026-11-11"], ["2026-11-11", "2026-11-12"]]);
  const monthly = { id: "m", start: "2026-01-31", end: "2026-01-31", repeat: "monthly" };
  assert.deepEqual(expandEvent(monthly, "2026-02-01", "2026-04-30").map((o) => o.occ), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  const yearly = { id: "y", start: "2024-02-29", end: "2024-02-29", repeat: "yearly" };
  assert.deepEqual(expandEvent(yearly, "2026-01-01", "2028-12-31").map((o) => o.occ), ["2026-02-28", "2027-02-28", "2028-02-29"]);
  const once = { id: "o", start: "2026-11-10", end: "2026-11-11", repeat: "none" };
  assert.equal(expandEvent(once, "2026-11-11", "2026-11-20").length, 1);
  assert.equal(expandEvent(once, "2026-11-12", "2026-11-20").length, 0);
});

test("毎年の予定の年数(○歳・○周年)。開始の年は出さない", () => {
  const e = { id: "b", start: "2020-11-05", end: "2020-11-05", repeat: "yearly", yearsLabel: "age" };
  const occ = expandEvent(e, "2026-11-01", "2026-11-30")[0];
  assert.equal(yearsText({ ...occ, baseStart: e.start }), "6歳");
  const first = expandEvent(e, "2020-11-01", "2020-11-30")[0];
  assert.equal(yearsText({ ...first, baseStart: e.start }), "");
  assert.equal(yearsText({ ...occ, baseStart: e.start, yearsLabel: "anniv" }), "6周年");
});

test("週の並べ方: 長い予定が先・重なれば段を分ける・段が足りなければ「+n」・週をまたぐ印", () => {
  const week = "2026-11-01";
  const ev = (id, s, e, extra = {}) => ({ id, start: s, end: e, title: id, allDay: true, ...extra });
  const out = layoutWeek(week, [ev("a", "2026-11-02", "2026-11-04"), ev("b", "2026-11-03", "2026-11-03"), ev("c", "2026-11-03", "2026-11-03"), ev("x", "2026-10-30", "2026-11-02")], 2);
  const laneOf = (id) => out.bars.find((b) => b.event.id === id)?.lane;
  assert.equal(laneOf("x"), 0); // 週の頭からのものが先
  assert.equal(out.bars.find((b) => b.event.id === "x").cutLeft, true);
  assert.equal(laneOf("a"), 1); // x と重なる(日曜〜月曜)ので次の段
  assert.equal(laneOf("b"), 0); // 火曜は x が終わっているので、上の段に入る
  assert.equal(laneOf("c"), undefined); // 3つ目の重なりは、2段までなので出ない
  assert.deepEqual(out.over, [0, 0, 1, 0, 0, 0, 0]); // 火曜に「+1」
  assert.equal(out.bars.length, 3);
});

test("1日の並び: 終日が先、次にラベルの順、時刻", () => {
  const list = [
    { title: "b", allDay: false, startTime: "10:00", labelRank: 0 },
    { title: "a", allDay: true, labelRank: 1 },
    { title: "c", allDay: false, startTime: "09:00", labelRank: 0 },
  ].sort(compareForDay);
  assert.deepEqual(list.map((e) => e.title), ["a", "c", "b"]);
});

test("色の上の文字: 明るい色には黒、暗い色には白", () => {
  assert.equal(textOn("#ffee88"), "#222");
  assert.equal(textOn("#3b6fd4"), "#fff");
  assert.equal(textOn("bad"), "#fff");
});

test("予定の日時の文字: 分単位の時刻・日をまたぐ", () => {
  assert.equal(whenText({ start: "2026-11-10", end: "2026-11-10", allDay: true }), "11/10(火)　終日");
  assert.equal(whenText({ start: "2026-11-10", end: "2026-11-10", allDay: false, startTime: "09:07", endTime: "10:43" }), "11/10(火)　9:07〜10:43");
  assert.equal(whenText({ start: "2026-11-10", end: "2026-11-11", allDay: false, startTime: "22:30", endTime: "08:15" }), "11/10(火) 22:30 〜 11/11(水) 8:15");
});

test("L3: 何か月も続く毎月の予定は、始まりが何か月も前にあるぶんを落とさない。毎年の予定(366日まで)も", () => {
  const monthly = { id: "m", start: "2026-01-01", end: "2026-04-21", repeat: "monthly" }; // 110日続く(毎月始まるので重なる)
  assert.deepEqual(expandEvent(monthly, "2026-06-01", "2026-06-10").map((o) => o.occ), ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]);
  const yearly = { id: "y", start: "2024-03-01", end: "2025-03-02", repeat: "yearly" }; // 366日続く
  assert.deepEqual(expandEvent(yearly, "2026-01-10", "2026-01-20").map((o) => o.occ), ["2025-03-01"]);
});

test("M1: 写真の期限(終了日から1か月後)が過ぎた予定は、写真を付けられない。繰り返しの予定は付けられる", () => {
  assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28"); // 月末に寄せる(DB と同じ)
  assert.equal(addMonthsIso("2026-12-15", 1), "2027-01-15");
  assert.equal(photosClosed({ end: "2026-10-03", repeat: "none" }, "2026-11-03"), false); // 期限は 11/3 (今日。まだ消えない)
  assert.equal(photosClosed({ end: "2026-10-02", repeat: "none" }, "2026-11-03"), true);
  assert.equal(photosClosed({ end: "2020-01-01", repeat: "yearly" }, "2026-11-03"), false);
});

test("L5: 予定を作れるいちばん古い日は、12か月前の月の1日(画面の見られる範囲と同じ)", () => {
  assert.equal(oldestDate("2026-11-03"), "2025-11-01");
  assert.equal(oldestDate("2027-01-31"), "2026-01-01");
});

test("カレンダーに出すもの: 自動(null)は Google の設定から決める。自分で決めた値(true/false)が先", () => {
  // Google に登録していて、休日用も非番用も無い → 休日は出さない・非番は別にしない
  assert.deepEqual(resolveCalView({ google_sync: true, holiday_calendar_id: "", offduty_calendar_id: "" }), { duty: true, off: false, offduty: false });
  // 休日用・非番用のカレンダーがある
  assert.deepEqual(resolveCalView({ google_sync: true, holiday_calendar_id: "h@x", offduty_calendar_id: "o@x" }), { duty: true, off: true, offduty: true });
  // Google に登録しない(アプリだけ): 休日は出す・非番は自分で入れるまで別にしない
  assert.deepEqual(resolveCalView({ google_sync: false, holiday_calendar_id: "", offduty_calendar_id: "" }), { duty: true, off: true, offduty: false });
  // 非番を2段で出す設定の人は、非番の時間を別のボタンにする(Google に登録しない人も)
  assert.deepEqual(resolveCalView({ google_sync: false, holiday_calendar_id: "", offduty_calendar_id: "", split_offduty_events: true }), { duty: true, off: true, offduty: true });
  // 設定の行がまだ無い人も、アプリだけの人と同じ
  assert.deepEqual(resolveCalView(null), { duty: true, off: true, offduty: false });
  // 自分で決めた値が先
  assert.deepEqual(resolveCalView({ google_sync: true, holiday_calendar_id: "", cal_show_off: true, cal_offduty_label: true, cal_show_duty: false }), { duty: false, off: true, offduty: true });
  assert.deepEqual(resolveCalView({ google_sync: true, holiday_calendar_id: "h", offduty_calendar_id: "o", cal_show_off: false, cal_offduty_label: false }), { duty: true, off: false, offduty: false });
});

test("別の日にコピー: 選んだ日から同じ長さ。月・年をまたいでも数える。終了日が前なら1日の予定", () => {
  assert.deepEqual(shiftSpan("2026-11-10", "2026-11-10", "2026-11-20"), { start: "2026-11-20", end: "2026-11-20" });
  assert.deepEqual(shiftSpan("2026-11-10", "2026-11-11", "2026-11-30"), { start: "2026-11-30", end: "2026-12-01" }); // 泊など2日間
  assert.deepEqual(shiftSpan("2026-11-10", "2026-11-12", "2027-02-27"), { start: "2027-02-27", end: "2027-03-01" });
  assert.deepEqual(shiftSpan("2026-11-10", "2026-11-09", "2026-11-15"), { start: "2026-11-15", end: "2026-11-15" });
});

test("別の日にコピー: 日付の並びは日付の順。年が違う日だけ年を付ける", () => {
  assert.equal(datesText(["2026-11-15", "2026-11-12", "2027-01-05"], "2026"), "11/12・11/15・2027/1/5");
  assert.equal(datesText([], 2026), "");
});

test("アナウンス: 日付ありは近い順に「M/D(曜) 名前 あと○日」(当日・期間中は「今日」)、そのあとに日付なし(予定は日の順・メモは並び順)。終わった予定・過ぎたメモ・出さないものは入れない", () => {
  const today = "2026-11-08";
  const own = [
    { id: "a", title: "旅行", start: "2026-11-20", end: "2026-11-21", repeat: "none", announce: "dated" },
    { id: "b", title: "研修", start: "2026-11-07", end: "2026-11-09", repeat: "none", announce: "dated" }, // 期間中
    { id: "c", title: "終わった", start: "2026-11-01", end: "2026-11-07", repeat: "none", announce: "dated" },
    { id: "d", title: "出さない", start: "2026-11-10", end: "2026-11-10", repeat: "none", announce: "none" },
    { id: "e", title: "運動会", start: "2026-11-15", end: "2026-11-15", repeat: "none", announce: "plain" },
    { id: "f", title: "誕生日", start: "2000-11-10", end: "2000-11-10", repeat: "yearly", yearsLabel: "age", announce: "dated" },
    { id: "g", title: "毎週の会議", start: "2026-10-05", end: "2026-10-05", repeat: "weekly", exdates: ["2026-11-09"], announce: "dated" },
  ];
  const memos = [
    { id: "m1", title: "ゴミの日", sort: 2, announce: "plain" },
    { id: "m2", title: "鍵の場所", sort: 1, announce: "plain" },
    { id: "m3", title: "車検", announce: "dated", announce_on: "2026-11-08" },
    { id: "m4", title: "過ぎた", announce: "dated", announce_on: "2026-11-07" },
    { id: "m5", title: "出さないメモ", announce: "none" },
  ];
  const list = announceItems(own, memos, today);
  assert.deepEqual(list.map((x) => x.text), [
    "今日 研修", "今日 車検", "11/10(火) 誕生日 26歳 あと2日", "11/16(月) 毎週の会議 あと8日", "11/20(金) 旅行 あと12日",
    "運動会", "鍵の場所", "ゴミの日",
  ]);
  // 繰り返しの予定は、その回の id(開くときに使う)。「この回だけ削除」した日は飛ばす
  assert.equal(list.find((x) => x.text.includes("会議")).id, "g@2026-11-16");
  assert.equal(list.find((x) => x.text.includes("旅行")).id, "a");
  assert.deepEqual(list.filter((x) => x.kind === "memo").map((x) => x.dated), [true, false, false]);
  assert.equal(ANNOUNCE_MAX, 10);
  assert.deepEqual(announceItems([], [], today), []);
});
