// node --test docs/kouban/test/kouban.test.mjs
// 交番表の計算(web/js/kouban.js)。データは架空(本物の交番表はリポジトリに置かない)
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkKouban, columnOn, groupOn, isSpare, koubanCode, officeHasKouban, parseKouban, readPrefs, validPos,
} from "../../../web/js/kouban.js";

// 6日周期・3行(1行ずつずらす)・名前の欄2つ(A は奇数月に「甲」・偶数月に「予」、B はいつも「甲」)
const BASE = ["①", "", "休", "②", "", "公"];
function sample() {
  const months = (odd, even) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), (i + 1) % 2 ? odd : even]));
  return {
    v: 1,
    start: "2026-10-01",
    days: 6,
    rows: ["1", "2", "3"],
    cells: [0, 1, 2].map((k) => BASE.map((_, j) => BASE[(j - k + 6) % 6])),
    cols: [{ label: "A", groups: months("甲", "予") }, { label: "B", groups: months("甲", "甲") }],
    routes: { 甲: { "①": "101", "②": "特2" } },
    off: { 休: "特休", 公: "公休" },
  };
}

test("区所の名前に天王寺車掌区が入っているときだけ", () => {
  assert.equal(officeHasKouban("天王寺車掌区"), true);
  assert.equal(officeHasKouban("天王寺車掌区(特)"), true);
  assert.equal(officeHasKouban("日根野車掌区"), false);
  assert.equal(officeHasKouban(null), false);
});

test("日付 → 列は start から days 日ごとに繰り返す(前の日も)", () => {
  const t = checkKouban(sample());
  assert.equal(columnOn(t, "2026-10-01"), 0);
  assert.equal(columnOn(t, "2026-10-06"), 5);
  assert.equal(columnOn(t, "2026-10-07"), 0);
  assert.equal(columnOn(t, "2026-09-30"), 5);
  // 30日周期: 11月1日は2列目(本物の交番表の見出しと同じ)
  const t30 = { ...t, days: 30 };
  assert.equal(columnOn(t30, "2026-11-01"), 1);
  assert.equal(columnOn(t30, "2026-11-30"), 0);
  assert.equal(columnOn(t30, "2027-03-01"), (151 % 30));
});

test("組は日付の月で決まる。行路の表が無い組は予備", () => {
  const t = checkKouban(sample());
  assert.equal(groupOn(t, 0, "2026-11-30"), "甲");
  assert.equal(groupOn(t, 0, "2026-12-01"), "予");
  assert.equal(isSpare(t, "予"), true);
  assert.equal(isSpare(t, "甲"), false);
});

test("乗務の組: 丸の数字は行路番号、休みのマスは off の番号、空は空", () => {
  const t = checkKouban(sample());
  const pos = { r: 0, c: 0 };
  const codes = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((k) => koubanCode(t, pos, k).code);
  // 11/1 は start から31日 → 31 mod 6 = 1 列目
  assert.deepEqual(codes, ["", "特休", "特2", "", "公休", "101"]);
  // 2行目は1列ずれる
  assert.equal(koubanCode(t, { r: 1, c: 0 }, "2026-10-02").cell, "①");
});

test("休みだけ: 丸の数字は入れない", () => {
  const t = checkKouban(sample());
  assert.equal(koubanCode(t, { r: 0, c: 0 }, "2026-10-01", { routes: false }).code, "");
  assert.equal(koubanCode(t, { r: 0, c: 0 }, "2026-10-03", { routes: false }).code, "特休");
});

test("予備: 丸の数字は入れず、休みは「休を入れる」のときだけ", () => {
  const t = checkKouban(sample());
  const pos = { r: 0, c: 0 };
  // 12/6 は start から66日 → 66 mod 6 = 0 列目(①)、12/2 は2列目(休)
  assert.equal(koubanCode(t, pos, "2026-12-06").cell, "①");
  assert.equal(koubanCode(t, pos, "2026-12-06").code, "");
  assert.equal(koubanCode(t, pos, "2026-12-06").spare, true);
  assert.equal(koubanCode(t, pos, "2026-12-02").code, "特休");
  assert.equal(koubanCode(t, pos, "2026-12-02", { spareOff: false }).code, "");
});

test("位置が表の外なら使えない", () => {
  const t = checkKouban(sample());
  assert.equal(validPos(t, { r: 2, c: 1 }), true);
  assert.equal(validPos(t, { r: 3, c: 0 }), false);
  assert.equal(validPos(t, { r: 0, c: 2 }), false);
  assert.equal(validPos(t, null), false);
});

test("形の確かめ: だめなものは日本語の理由で断る", () => {
  const bad = (fn, re) => assert.throws(() => checkKouban(fn(sample())), re);
  bad((d) => ({ ...d, v: 2 }), /v が 1/);
  bad((d) => ({ ...d, start: "2026-02-30" }), /start/);
  bad((d) => ({ ...d, days: 0 }), /days/);
  bad((d) => { d.cells[1] = d.cells[1].slice(1); return d; }, /2行目のマスが 6 個/);
  bad((d) => { d.cells[0][1] = "夜"; return d; }, /「夜」/);
  bad((d) => ({ ...d, rows: ["1"] }), /rows/);
  bad((d) => { delete d.routes.甲["②"]; return d; }, /甲」に ②/);
  bad((d) => { delete d.cols[1].groups["7"]; return d; }, /7月/);
  bad((d) => ({ ...d, off: { "①": "x" } }), /使えません/);
  bad((d) => ({ ...d, routes: {} }), /routes/);
  assert.throws(() => parseKouban("{"), /JSON/);
  assert.throws(() => parseKouban(""), /空/);
  assert.throws(() => parseKouban("x".repeat(100001)), /長すぎ/);
});

test("形の確かめ: 空白・制御文字は整える", () => {
  const d = sample();
  d.cells[0][1] = " ";
  d.routes.甲["①"] = " 101\n";
  const t = checkKouban(d);
  assert.equal(t.cells[0][1], "");
  assert.equal(t.routes.甲["①"], "101");
  assert.equal(parseKouban(JSON.stringify(sample())).days, 6);
});

test("設定の読み込み: おかしな値は捨てて、はじめは「行路も」「休を入れる」", () => {
  assert.deepEqual(readPrefs(null), { pos: {}, routes: true, spareOff: true });
  assert.deepEqual(readPrefs({ pos: { 5: { r: 1, c: 2 }, x: { r: 1, c: 1 }, 6: { r: -1, c: 0 }, 7: { r: 1.5, c: 0 } }, routes: false, spareOff: false }),
    { pos: { 5: { r: 1, c: 2 } }, routes: false, spareOff: false });
});
