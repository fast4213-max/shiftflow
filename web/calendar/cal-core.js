// shiftflowカレンダーの、画面に関係しない計算(日付・繰り返し・週の中の並べ方・色)。
// 日付は "yyyy-MM-dd" の文字で持ち、計算は UTC で行う(端末の時間帯・夏時間に左右されない)。
// テスト: docs/mycalendar/test/cal-core.test.mjs(node --test)

export const pad = (n) => String(n).padStart(2, "0");

export function parseIso(s) {
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
}
export function toIso(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function addDays(s, n) {
  const d = parseIso(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}
export function diffDays(a, b) {
  return Math.round((parseIso(b) - parseIso(a)) / 86400000);
}
export function weekday(s) {
  return parseIso(s).getUTCDay(); // 0=日
}
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function dateKey(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}
// 日本の今日(端末の時間帯に関係なく)
export function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
}
export function addMonths(y, m, n) {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

// 月の画面に出す日の範囲(日曜はじまりの週で、前後の月の日も含む)
export function gridRange(y, m) {
  const first = dateKey(y, m, 1);
  const last = dateKey(y, m, daysInMonth(y, m));
  const from = addDays(first, -weekday(first));
  const to = addDays(last, 6 - weekday(last));
  return { from, to, first, last };
}

// 見られる月の範囲: 今日の月の12か月前〜来年の12月(祝日を読める範囲に合わせる)
export function monthLimits(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return { min: addMonths(y, m, -12), max: { y: y + 1, m: 12 } };
}
export function monthIndex(y, m) {
  return y * 12 + m - 1;
}

// ---------- 繰り返し ----------

// 月・年の繰り返しで、その月に同じ日がないとき(31日・2/29)は、その月の最終日に寄せる
function monthlyDate(base, k) {
  const y = base.getUTCFullYear();
  const mm = base.getUTCMonth() + k;
  const ty = y + Math.floor(mm / 12);
  const tm = ((mm % 12) + 12) % 12;
  return new Date(Date.UTC(ty, tm, Math.min(base.getUTCDate(), new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate())));
}
function yearlyDate(base, k) {
  const ty = base.getUTCFullYear() + k;
  const tm = base.getUTCMonth();
  return new Date(Date.UTC(ty, tm, Math.min(base.getUTCDate(), new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate())));
}

// 予定 e({id, start, end, repeat, until, exdates})のうち、a〜b(日付)にかかる回を作る。
// 繰り返しなしは e のまま。繰り返しは、各回に occ(その回の開始日)・baseId を付ける。exdates の日(「この回だけ」消した)は作らない
export function expandEvent(e, a, b) {
  const rp = e.repeat;
  if (!rp || rp === "none") return e.end >= a && e.start <= b ? [e] : [];
  const dur = diffDays(e.start, e.end);
  const base = parseIso(e.start);
  const ex = e.exdates && e.exdates.length ? new Set(e.exdates) : null;
  const lim = e.until && e.until < b ? e.until : b;
  let k0 = 0;
  if (rp === "daily") k0 = Math.max(0, diffDays(e.start, a) - dur - 1);
  else if (rp === "weekly") k0 = Math.max(0, Math.floor((diffDays(e.start, a) - dur) / 7) - 1);
  // 毎月・毎年は、長い予定(何か月も続く)の始まりが、a より何か月・何年も前にあることがあるので、長さぶん手前から数える
  else if (rp === "monthly") k0 = Math.max(0, Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7)) - (base.getUTCFullYear() * 12 + base.getUTCMonth() + 1) - (Math.ceil(dur / 28) + 1));
  else if (rp === "yearly") k0 = Math.max(0, Number(a.slice(0, 4)) - base.getUTCFullYear() - (1 + Math.ceil(dur / 365)));
  const out = [];
  for (let k = k0; k < k0 + 6000; k++) {
    const d = rp === "daily" ? new Date(base.getTime() + k * 86400000)
      : rp === "weekly" ? new Date(base.getTime() + 7 * k * 86400000)
      : rp === "monthly" ? monthlyDate(base, k) : yearlyDate(base, k);
    const s = toIso(d);
    if (s > lim) break;
    const en = addDays(s, dur);
    if (en >= a && !(ex && ex.has(s))) out.push({ ...e, id: `${e.id}@${s}`, baseId: e.id, occ: s, start: s, end: en });
  }
  return out;
}

// 毎年の予定の年数の表示(誕生日の「○歳」・記念日の「○周年」)。開始日の年から数え、0のときは出さない
export function yearsText(e) {
  if (e.repeat !== "yearly" || !e.yearsLabel || !e.occ) return "";
  const n = Number(e.occ.slice(0, 4)) - Number(e.baseStart.slice(0, 4));
  if (n <= 0) return "";
  return e.yearsLabel === "age" ? `${n}歳` : `${n}周年`;
}

// ---------- 色 ----------

// 色の帯の上の文字色(明るい色には黒、暗い色には白)
export function textOn(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.68 ? "#222" : "#fff";
}

// ---------- 週の中の並べ方 ----------

// 1つの週(日曜はじまり)に、予定の帯を並べる。
//   events: {id, start, end, allDay, startTime, title, labelRank} の配列(日付の文字)
//   戻り値: bars = [{event, c1, c2, lane, cutLeft, cutRight}](c1・c2は0〜6の列)、over = 列ごとの「+n」(段が足りず出せない数)
export function layoutWeek(weekStart, events, maxLanes) {
  const weekEnd = addDays(weekStart, 6);
  const segs = [];
  for (const e of events) {
    if (e.end < weekStart || e.start > weekEnd) continue;
    const s = e.start > weekStart ? e.start : weekStart;
    const t = e.end < weekEnd ? e.end : weekEnd;
    segs.push({ event: e, c1: diffDays(weekStart, s), c2: diffDays(weekStart, t), cutLeft: e.start < weekStart, cutRight: e.end > weekEnd });
  }
  segs.sort((a, b) =>
    (a.c1 - b.c1) || ((b.c2 - b.c1) - (a.c2 - a.c1)) ||
    ((a.event.labelRank || 0) - (b.event.labelRank || 0)) ||
    ((b.event.allDay ? 1 : 0) - (a.event.allDay ? 1 : 0)) ||
    String(a.event.startTime || "").localeCompare(String(b.event.startTime || "")) ||
    String(a.event.title).localeCompare(String(b.event.title)));
  const occ = [];
  const over = [0, 0, 0, 0, 0, 0, 0];
  for (const sg of segs) {
    let lane = 0;
    for (;; lane++) {
      occ[lane] = occ[lane] || [];
      let free = true;
      for (let c = sg.c1; c <= sg.c2; c++) if (occ[lane][c]) { free = false; break; }
      if (free) break;
    }
    for (let c = sg.c1; c <= sg.c2; c++) occ[lane][c] = 1;
    sg.lane = lane;
    if (lane >= maxLanes) for (let c = sg.c1; c <= sg.c2; c++) over[c]++;
  }
  return { bars: segs.filter((s) => s.lane < maxLanes), over };
}

// 1日の予定の並び(終日・長い予定が先、次にラベルの並び順、時刻、名前)
export function compareForDay(a, b) {
  return ((b.allDay ? 1 : 0) - (a.allDay ? 1 : 0)) || ((a.labelRank || 0) - (b.labelRank || 0)) ||
    String(a.startTime || "").localeCompare(String(b.startTime || "")) || String(a.title).localeCompare(String(b.title));
}

// 予定の日時の文字(例: 11/10(火) 9:07〜10:43 / 11/10(火) 22:30 〜 11/11(水) 8:15)
const WD = ["日", "月", "火", "水", "木", "金", "土"];
export function whenText(e) {
  const f = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}(${WD[weekday(s)]})`;
  const t = (x) => (x ? x.replace(/^0/, "") : "");
  if (e.start === e.end) return f(e.start) + (e.allDay ? "　終日" : `　${t(e.startTime)}${e.endTime ? "〜" + t(e.endTime) : ""}`);
  return `${f(e.start)}${e.allDay ? "" : " " + t(e.startTime)} 〜 ${f(e.end)}${e.allDay ? "" : e.endTime ? " " + t(e.endTime) : ""}`;
}
export { WD as WEEKDAYS };

// ---------- 保存期間・写真の期限(DB と同じ数え方) ----------

// 月を足す。その月に同じ日がなければ、最終日に寄せる(Postgres の date + interval '1 month' と同じ)
export function addMonthsIso(s, n) {
  const y = Number(s.slice(0, 4));
  const m0 = Number(s.slice(5, 7)) - 1 + n;
  const ty = y + Math.floor(m0 / 12);
  const tm = ((m0 % 12) + 12) % 12;
  return dateKey(ty, tm + 1, Math.min(Number(s.slice(8, 10)), daysInMonth(ty, tm + 1)));
}

// 予定の写真の期限(終了日から1か月後)が、もう過ぎているか。繰り返しの予定の写真は消えないので、過ぎない
export function photosClosed({ end, repeat }, today) {
  return (!repeat || repeat === "none") && addMonthsIso(end, 1) < today;
}

// 予定を作れる、いちばん古い日(12か月前の月の1日。これより前の予定は、夜の処理で消える)
export function oldestDate(today) {
  const m = monthLimits(today).min;
  return dateKey(m.y, m.m, 1);
}
