// 小さな CSV パーサ(ダブルクォート・改行入りのセルに対応)

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// UTF-8 で読めなければ Shift_JIS(Excel で保存した CSV)として読む
export async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("shift_jis").decode(buf);
  } catch (_) {
    return utf8;
  }
}

const COLUMNS = {
  番号: "code",
  種別: "kind",
  平日出勤: "weekday_start",
  平日退勤: "weekday_end",
  休日出勤: "holiday_start",
  休日退勤: "holiday_end",
  泊: "stay",
};
const REQUIRED = ["番号", "種別", "平日出勤", "平日退勤", "休日出勤", "休日退勤"];

// マスタの CSV → replace_shift_master に渡す行の配列。列の順番は自由
export function masterRowsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV にデータがありません。");
  const header = rows[0].map((h) => h.trim());
  const missing = REQUIRED.filter((name) => header.indexOf(name) === -1);
  if (missing.length) throw new Error("1行目に「" + missing.join("」「") + "」列がありません。");
  return rows
    .slice(1)
    .map((r) => {
      const obj = {};
      Object.entries(COLUMNS).forEach(([ja, en]) => {
        const i = header.indexOf(ja);
        obj[en] = i === -1 ? "" : (r[i] || "").trim();
      });
      return obj;
    })
    .filter((r) => r.code !== "");
}
