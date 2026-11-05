// 交番表から休みを自動入力(計算だけ。画面に関係しない部分)。設計は docs/kouban/DESIGN.md
// 本人が ⚙ で覚えた休みの並び(始まりの日から一周分)を、日ごとに繰り返す。交番表のデータは持たない。
//
// 覚える形(user_settings.kouban):
//   { "start": "2026-11-01", "cycle": 30, "days": { "3": "特休", "4": "公休" }, "spareMonths": [2, 5, 8, 11], "spareOff": true }
//   days は「始まりの日から何日目(0 から)」→ 休みの番号。spareOff は、予備の月も休みを入れるか

export const MIN_CYCLE = 7;
export const MAX_CYCLE = 99;
export const DEFAULT_CYCLE = 30;
const MAX_CODE = 30;

// ---------- 日付(plan.js に頼らない。node のテストでそのまま読めるように) ----------

function dayNumber(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function isDateKey(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isCycle(n) {
  return Number.isInteger(n) && n >= MIN_CYCLE && n <= MAX_CYCLE;
}

// 番号: 改行・制御文字は空白にして前後の空白を除く。長すぎるもの・空は ""
export function cleanCode(value) {
  if (typeof value !== "string") return "";
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s.length > MAX_CODE ? "" : s;
}

// ---------- 読み込み ----------

// user_settings.kouban を読みやすい形に。まだ無い・おかしいときは null。
// おかしな日・番号・月は捨てる(DB の値を手で直した・前の版の形などでも、画面が止まらないように)
export function readKouban(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isDateKey(value.start) || !isCycle(value.cycle)) return null;
  const days = {};
  if (value.days && typeof value.days === "object" && !Array.isArray(value.days)) {
    Object.entries(value.days).forEach(([i, code]) => {
      const n = Number(i);
      const c = cleanCode(code);
      if (/^\d+$/.test(i) && n < value.cycle && c) days[n] = c;
    });
  }
  const spareMonths = [...new Set((Array.isArray(value.spareMonths) ? value.spareMonths : [])
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  return { start: value.start, cycle: value.cycle, days, spareMonths, spareOff: value.spareOff !== false };
}

// 保存する形(readKouban で読める形)
export function koubanValue(k) {
  const days = {};
  Object.keys(k.days).map(Number).sort((a, b) => a - b).forEach((i) => {
    if (i >= 0 && i < k.cycle && cleanCode(k.days[i])) days[i] = cleanCode(k.days[i]);
  });
  return { start: k.start, cycle: k.cycle, days, spareMonths: [...k.spareMonths].sort((a, b) => a - b), spareOff: k.spareOff !== false };
}

export function hasPattern(k) {
  return !!k && Object.keys(k.days).length > 0;
}

// ---------- 日ごと ----------

// その日が並びの何日目か(0 から)。始まりの日より前の日も、一周ごとに繰り返す
export function indexOn(k, key) {
  const n = dayNumber(key) - dayNumber(k.start);
  return ((n % k.cycle) + k.cycle) % k.cycle;
}

export function isSpareMonth(k, month) {
  return k.spareMonths.includes(Number(month));
}

// その日に入れる休みの番号("" なら入れない)。予備の月で「何もしない」なら ""
export function offOn(k, key) {
  if (!k.spareOff && isSpareMonth(k, Number(key.slice(5, 7)))) return "";
  return k.days[indexOn(k, key)] || "";
}

// ---------- 設定の画面で使うもの ----------

// タップで切り替える次の休み。order は区所のマスタの休日の番号(並び順)。
// なし → order[0] → … → 最後 → なし。今の番号が order に無ければ(マスタが変わったなど)、なし に戻す
export function nextOff(order, current) {
  if (!current) return order[0] || "";
  const i = order.indexOf(current);
  return i < 0 || i === order.length - 1 ? "" : order[i + 1];
}

// 始まりの日を変えたとき: タップした日(本当の日付)が変わらないよう、日を数え直す
export function moveStart(days, oldStart, newStart, cycle) {
  const shift = dayNumber(oldStart) - dayNumber(newStart);
  const out = {};
  Object.entries(days).forEach(([i, code]) => {
    out[(((Number(i) + shift) % cycle) + cycle) % cycle] = code;
  });
  return out;
}

// 一周の日数を変えたとき: 一周の外に出る日(消える日の数)と、残る日
export function fitCycle(days, cycle) {
  const kept = {};
  let dropped = 0;
  Object.entries(days).forEach(([i, code]) => {
    if (Number(i) < cycle) kept[i] = code;
    else dropped++;
  });
  return { days: kept, dropped };
}
