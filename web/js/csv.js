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
  // 以下の4列は無くてもよい(泊の番号で使う)
  平休出勤: "weekday_holiday_start", // 平日に泊 → 翌日が休日 のときの出勤
  平休退勤: "weekday_holiday_end", //   同じく退勤
  休平出勤: "holiday_weekday_start", // 休日に泊 → 翌日が平日 のときの出勤
  休平退勤: "holiday_weekday_end", //   同じく退勤
};
const REQUIRED = ["番号", "種別", "平日出勤", "平日退勤", "休日出勤", "休日退勤"];

// 番号の全角の英数字・記号(！〜～)と全角の空白を半角にそろえる(日本語の文字はそのまま)。
// 全角と半角が混ざっても、手入力で一覧の番号と合うように、重複もそろえて見つけられるように
export function normalizeCode(value) {
  return String(value || "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .trim();
}

// マスタの CSV → replace_shift_master に渡す行の配列。列の順番は自由。
// 番号だけ空の行も残す(checkMasterRows で「番号が空」にして、写し漏れに気づけるように)
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
      obj.code = normalizeCode(obj.code);
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v !== ""));
}

// 時刻の欄の「-」「－」「―」「ー」「×」「・」「＊」「／」など、記号だけのもの(時刻なしの印)。
// 「〃」(上と同じ)は空にすると違う時刻になるので含めない(「時刻が読めない」になる)
export function isNoTimeMark(value) {
  return /^[\s\-－―ー−‐‑–—ｰ~〜～×✕xX・･*＊/／]+$/.test(String(value || ""));
}

// "09:01:00" や "(9:01)" を "9:01" にそろえる(DB の normalize_time と同じ)
export function normalizeTime(value) {
  const m = String(value || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + ":" + m[2] : "";
}

const TIME_FIELDS = [
  "weekday_start", "weekday_end", "holiday_start", "holiday_end",
  "weekday_holiday_start", "weekday_holiday_end", "holiday_weekday_start", "holiday_weekday_end",
];
const CROSS_FIELDS = ["weekday_holiday_start", "weekday_holiday_end", "holiday_weekday_start", "holiday_weekday_end"];

// 取り込み前の確認: 時刻をそろえ、行ごとの問題を返す
//   戻り値: [{ ...row(時刻はそろえた値), errors: ["..."] }]
export function checkMasterRows(rows) {
  const count = Object.create(null); // 番号が constructor などでも数えられるよう、継承の無い連想配列にする
  rows.forEach((r) => (count[r.code] = (count[r.code] || 0) + 1));
  return rows.map((r) => {
    const errors = [];
    const out = { ...r };
    if (!r.code) errors.push("番号が空");
    if (["泊", "日勤", "休日"].indexOf(r.kind) === -1) errors.push("種別は 泊/日勤/休日");
    if (r.code && count[r.code] > 1) errors.push("番号が重複");
    const unreadable = new Set();
    TIME_FIELDS.forEach((f) => {
      // 記号だけの欄(「-」「×」など)は、時刻なし(空)として扱う
      const raw = isNoTimeMark(r[f]) ? "" : r[f];
      out[f] = normalizeTime(raw);
      if (raw && !out[f]) {
        errors.push("時刻が読めない: " + r[f]);
        unreadable.add(f);
      }
    });
    // 平休・休平の列は泊だけで使う。日勤・休日の行に書いてあっても使われないので、気づけるようにする
    if (r.kind !== "泊" && CROSS_FIELDS.some((f) => out[f])) errors.push("平休・休平の時刻は泊だけ");
    // 休日だけ動く番号(平日の時刻が空で、休日の時刻だけある)も取り込める。平日・休日とも出勤が空ならエラー
    // (読めない時刻の欄は、そのエラーだけを出す)
    const startBlank = (f) => !out[f] && !unreadable.has(f);
    if (r.kind !== "休日" && startBlank("weekday_start") && startBlank("holiday_start")) errors.push("出勤が空(平日・休日とも)");
    out.errors = errors;
    return out;
  });
}

function csvCell(v) {
  v = String(v == null ? "" : v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// マスタの行 → CSV(Excel でも文字化けしないよう BOM 付き)
export function masterToCsv(rows) {
  const header = ["番号", "種別", "平日出勤", "平日退勤", "休日出勤", "休日退勤", "泊", "平休出勤", "平休退勤", "休平出勤", "休平退勤"];
  const lines = [header.join(",")].concat(rows.map((r) =>
    [r.code, r.kind, r.weekday_start, r.weekday_end, r.holiday_start, r.holiday_end, r.stay,
      r.weekday_holiday_start, r.weekday_holiday_end, r.holiday_weekday_start, r.holiday_weekday_end].map(csvCell).join(",")
  ));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
