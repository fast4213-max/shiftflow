// 交番表から自動入力(計算だけ。画面に関係しない部分)。設計は docs/kouban/DESIGN.md
// 交番表の中身は DB(kouban_tables)にあり、ここには置かない(公開リポジトリのため)。

// この文字が区所の名前に入っている人だけ、勤務入力に「交番表」を出す
export const KOUBAN_OFFICE_WORD = "天王寺車掌区";

export const MAX_JSON = 100000; // 交番表の JSON の上限(文字数。DB でも見る)

const CIRCLED = /^[①-⑳]$/; // ①〜⑳

export function isCircled(cell) {
  return CIRCLED.test(cell);
}

export function officeHasKouban(name) {
  return String(name || "").includes(KOUBAN_OFFICE_WORD);
}

// ---------- 日付(plan.js に頼らない。node のテストでそのまま読めるように) ----------

function dayNumber(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function isDateKey(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------- 確かめ ----------

function fail(text) {
  throw new Error("交番表の形が違います: " + text);
}

function str(value, max, what) {
  if (typeof value !== "string") fail(what + "が文字ではありません");
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > max) fail(what + "は" + max + "文字までです(" + s.slice(0, 20) + "…)");
  return s;
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// 管理画面で貼った文字(JSON)を読んで確かめる。だめなら Error(日本語の理由)
export function parseKouban(text) {
  const t = String(text || "").trim();
  if (!t) fail("空です");
  if (t.length > MAX_JSON) fail("長すぎます(" + MAX_JSON + "文字まで)");
  let data;
  try {
    data = JSON.parse(t);
  } catch (_) {
    fail("JSON として読めません(貼り付けが途中で切れていないか確かめてください)");
  }
  return checkKouban(data);
}

// 中身を確かめて、整えたもの(前後の空白などを除いた新しいオブジェクト)を返す
export function checkKouban(data) {
  if (!isObject(data)) fail("{ } で囲まれていません");
  if (data.v !== 1) fail("v が 1 ではありません");
  if (!isDateKey(data.start)) fail("start(1列目の日)は 2026-10-01 の形にしてください");
  const days = data.days;
  if (!Number.isInteger(days) || days < 1 || days > 62) fail("days(列の数)は 1〜62 にしてください");

  if (!isObject(data.off)) fail("off(休みのマス)がありません");
  const off = {};
  Object.entries(data.off).forEach(([k, v]) => {
    const key = str(k, 10, "off のマス");
    if (!key || isCircled(key)) fail("off のマス「" + k + "」は使えません");
    const code = str(v, 30, "off の番号");
    if (!code) fail("off の「" + key + "」の番号が空です");
    off[key] = code;
  });

  if (!Array.isArray(data.cells) || !data.cells.length || data.cells.length > 60) fail("cells(マス)は 1〜60 行にしてください");
  const used = new Set();
  const cells = data.cells.map((row, i) => {
    if (!Array.isArray(row) || row.length !== days) fail((i + 1) + "行目のマスが " + days + " 個ではありません");
    return row.map((c, j) => {
      const s = str(c == null ? "" : c, 10, "マス");
      if (s && !isCircled(s) && !off[s]) fail((i + 1) + "行目 " + (j + 1) + "列目の「" + s + "」は、丸の数字でも off にあるものでもありません");
      if (isCircled(s)) used.add(s);
      return s;
    });
  });

  const rowsIn = Array.isArray(data.rows) ? data.rows : [];
  if (rowsIn.length !== cells.length) fail("rows(行の見出し)の数が cells の行の数と違います");
  const rows = rowsIn.map((r) => str(String(r), 20, "行の見出し"));

  const routes = {};
  if (!isObject(data.routes) || !Object.keys(data.routes).length) fail("routes(行路の表)がありません");
  Object.entries(data.routes).forEach(([g, map]) => {
    const group = str(g, 10, "routes の組");
    if (!group) fail("routes の組の名前が空です");
    if (!isObject(map)) fail("routes の「" + group + "」が { } ではありません");
    const out = {};
    Object.entries(map).forEach(([k, v]) => {
      const key = str(k, 10, "routes のマス");
      if (!isCircled(key)) fail("routes の「" + group + "」の「" + k + "」は丸の数字ではありません");
      const code = str(String(v), 30, "行路番号");
      if (!code) fail("routes の「" + group + "」の" + key + "の行路番号が空です");
      out[key] = code;
    });
    const missing = [...used].filter((c) => !out[c]).sort();
    if (missing.length) fail("routes の「" + group + "」に " + missing.join("") + " がありません");
    routes[group] = out;
  });

  if (!Array.isArray(data.cols) || !data.cols.length || data.cols.length > 12) fail("cols(名前の欄)は 1〜12 個にしてください");
  const cols = data.cols.map((col, i) => {
    if (!isObject(col)) fail("cols の " + (i + 1) + "つ目が { } ではありません");
    const label = str(col.label == null ? "" : String(col.label), 20, "名前の欄の見出し");
    if (!isObject(col.groups)) fail("cols の " + (i + 1) + "つ目に groups(月 → 組)がありません");
    const groups = {};
    for (let m = 1; m <= 12; m++) {
      const g = col.groups[String(m)];
      if (g == null) fail("cols の " + (i + 1) + "つ目の groups に " + m + "月がありません");
      groups[m] = str(String(g), 10, "組");
      if (!groups[m]) fail("cols の " + (i + 1) + "つ目の " + m + "月の組が空です");
    }
    return { label: label || String(i + 1), groups };
  });

  return { v: 1, start: data.start, days, rows, cells, cols, routes, off };
}

// ---------- 日ごと ----------

// その日が何列目か(0 から)。start より前の日も、days 日ごとに繰り返す
export function columnOn(table, key) {
  const n = dayNumber(key) - dayNumber(table.start);
  return ((n % table.days) + table.days) % table.days;
}

// 名前の欄 c の、その日(の月)の組
export function groupOn(table, c, key) {
  const col = table.cols[c];
  return col ? col.groups[Number(key.slice(5, 7))] || "" : "";
}

// 予備(行路の表が無い組。特予・近予・M組)か
export function isSpare(table, group) {
  return !table.routes[group];
}

export function validPos(table, pos) {
  return !!pos && Number.isInteger(pos.r) && Number.isInteger(pos.c) &&
    pos.r >= 0 && pos.r < table.cells.length && pos.c >= 0 && pos.c < table.cols.length;
}

// その日の番号。opts: { routes: 行路も入れる, spareOff: 予備・M組のとき休を入れる }
// 戻り値 { code, cell, group, spare }。code が "" なら何も入れない日
export function koubanCode(table, pos, key, opts = {}) {
  const routesOn = opts.routes !== false;
  const spareOff = opts.spareOff !== false;
  const cell = table.cells[pos.r][columnOn(table, key)] || "";
  const group = groupOn(table, pos.c, key);
  const spare = isSpare(table, group);
  let code = "";
  if (table.off[cell]) code = !spare || spareOff ? table.off[cell] : "";
  else if (isCircled(cell) && routesOn && !spare) code = table.routes[group][cell] || "";
  return { code, cell, group, spare };
}

// 位置の設定(user_settings.kouban)を読みやすい形に。おかしな値は捨てる
export function readPrefs(value) {
  const v = isObject(value) ? value : {};
  const pos = {};
  if (isObject(v.pos)) {
    Object.entries(v.pos).forEach(([id, p]) => {
      if (/^\d+$/.test(id) && isObject(p) && Number.isInteger(p.r) && Number.isInteger(p.c) && p.r >= 0 && p.c >= 0) pos[id] = { r: p.r, c: p.c };
    });
  }
  return { pos, routes: v.routes !== false, spareOff: v.spareOff !== false };
}
