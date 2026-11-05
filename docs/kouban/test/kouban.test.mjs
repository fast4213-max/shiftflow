// node --test docs/kouban/test/kouban.test.mjs
// 交番表から休みを入れる計算(web/js/kouban.js)。データは架空
import test from "node:test";
import assert from "node:assert/strict";
import {
  fitCycle, hasPattern, indexOn, isSpareMonth, koubanValue, moveStart, nextOff, offOn, readKouban,
} from "../../../web/js/kouban.js";

const sample = (extra = {}) => readKouban({ start: "2026-11-01", cycle: 30, days: { 2: "特休", 3: "公休", 13: "特公" }, spareMonths: [2, 5, 8, 11], spareOff: true, ...extra });

test("読み込み: まだ無い・おかしい形は null", () => {
  assert.equal(readKouban(null), null);
  assert.equal(readKouban({}), null);
  assert.equal(readKouban([]), null);
  assert.equal(readKouban({ start: "2026-02-30", cycle: 30 }), null);
  assert.equal(readKouban({ start: "2026-11-01", cycle: 6 }), null);
  assert.equal(readKouban({ start: "2026-11-01", cycle: 100 }), null);
  assert.equal(readKouban({ start: "2026-11-01", cycle: 30.5 }), null);
  // 前の版(位置を覚える形)も null
  assert.equal(readKouban({ pos: { 1: { r: 0, c: 0 } }, routes: true }), null);
});

test("読み込み: おかしな日・番号・月は捨てる。はじめは予備の月も休みを入れる", () => {
  const k = readKouban({ start: "2026-11-01", cycle: 7, days: { 0: " 公休\n", 7: "特休", x: "特休", 2: "", 3: 5, 4: "あ".repeat(31) }, spareMonths: [13, 2, 2, 0, 1.5, 11] });
  assert.deepEqual(k.days, { 0: "公休" });
  assert.deepEqual(k.spareMonths, [2, 11]);
  assert.equal(k.spareOff, true);
  assert.equal(readKouban({ start: "2026-11-01", cycle: 7, spareOff: false }).spareOff, false);
  assert.equal(hasPattern(readKouban({ start: "2026-11-01", cycle: 7 })), false);
  assert.equal(hasPattern(k), true);
});

test("保存する形は、読み直すと同じ", () => {
  const k = sample();
  assert.deepEqual(readKouban(koubanValue(k)), k);
  assert.deepEqual(koubanValue(k), { start: "2026-11-01", cycle: 30, days: { 2: "特休", 3: "公休", 13: "特公" }, spareMonths: [2, 5, 8, 11], spareOff: true });
});

test("日 → 並びの何日目かは、一周ごとに繰り返す(始まりの日より前も)", () => {
  const k = sample();
  assert.equal(indexOn(k, "2026-11-01"), 0);
  assert.equal(indexOn(k, "2026-11-30"), 29);
  assert.equal(indexOn(k, "2026-12-01"), 0);
  assert.equal(indexOn(k, "2026-10-31"), 29);
  assert.equal(indexOn(k, "2027-03-01"), 120 % 30);
  assert.equal(indexOn({ ...k, cycle: 7 }, "2026-11-09"), 1);
});

test("日ごとの休み: 並びの休みを繰り返す", () => {
  const k = sample({ spareMonths: [] });
  assert.equal(offOn(k, "2026-11-03"), "特休");
  assert.equal(offOn(k, "2026-11-04"), "公休");
  assert.equal(offOn(k, "2026-11-14"), "特公");
  assert.equal(offOn(k, "2026-11-05"), "");
  assert.equal(offOn(k, "2026-12-03"), "特休"); // 30日後
  assert.equal(offOn(k, "2026-10-04"), "特休"); // 30日前
});

test("予備の月: 「何もしない」なら入れない。「休みを入れる」なら同じ", () => {
  assert.equal(isSpareMonth(sample(), 11), true);
  assert.equal(isSpareMonth(sample(), 12), false);
  assert.equal(offOn(sample(), "2026-11-03"), "特休");
  const off = sample({ spareOff: false });
  assert.equal(offOn(off, "2026-11-03"), "");
  assert.equal(offOn(off, "2026-12-03"), "特休");
});

test("タップで切り替える順: なし → マスタの順 → なし", () => {
  const order = ["特休", "公休", "特公"];
  assert.equal(nextOff(order, ""), "特休");
  assert.equal(nextOff(order, "特休"), "公休");
  assert.equal(nextOff(order, "公休"), "特公");
  assert.equal(nextOff(order, "特公"), "");
  assert.equal(nextOff(order, "年休"), ""); // マスタに無くなった番号
  assert.equal(nextOff([], ""), "");
});

test("始まりの日を変えても、タップした本当の日付は変わらない", () => {
  // 11/3(2日目)と 11/30(29日目)
  const days = { 2: "特休", 29: "公休" };
  const moved = moveStart(days, "2026-11-01", "2026-11-03", 30);
  assert.deepEqual(moved, { 0: "特休", 27: "公休" });
  // 前にずらすと、一周の外に出た日は前に回る
  assert.deepEqual(moveStart(days, "2026-11-01", "2026-10-30", 30), { 4: "特休", 1: "公休" });
  const k = readKouban({ start: "2026-11-03", cycle: 30, days: moved });
  assert.equal(offOn(k, "2026-11-03"), "特休");
  assert.equal(offOn(k, "2026-11-30"), "公休");
});

test("一周の日数を短くすると、外に出る日は消える", () => {
  assert.deepEqual(fitCycle({ 2: "特休", 29: "公休", 6: "特公" }, 7), { days: { 2: "特休", 6: "特公" }, dropped: 1 });
  assert.deepEqual(fitCycle({ 2: "特休" }, 30), { days: { 2: "特休" }, dropped: 0 });
});
