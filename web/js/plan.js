// shiftflow - 予定の組み立て(平休判定・自動メモ・非番)
//
// Edge Function(Deno)とブラウザの両方で使う。
// web/js/plan.js は このファイルのコピー(内容が同じことをテストで確認している)。
// 変更するときは両方を同じにすること。
//
// 予定はすべて終日。
//   泊   : タイトル=番号 / メモ=出勤時間(2行目に泊地。出勤時間の列は dutyMemo を参照)
//   日勤 : タイトル=番号 / メモ=出勤〜退勤 (例: 10:15〜19:02)
//   非番 : タイトル=「〜」 / メモ=退勤時間 (泊の翌日に自動作成。退勤時間の列は offdutyMemo を参照)
//   休日 : タイトル=番号(特休など) / メモなし(休日用カレンダー)
//   手入力 : タイトル=入力文字 / メモなし
// 時間は、その日が土日祝・年末年始(12/30〜1/3)なら「休日」、それ以外は「平日」の列を使う。
// メモを手修正した日は、その内容をメモの1行目にする(泊地は2行目に残る)。

export const OFFDUTY_TITLE = "〜";

// ---------- 日付(タイムゾーンに左右されないよう UTC で計算する) ----------

export function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

export function dateKey(year, month, day) {
  return year + "-" + pad(month) + "-" + pad(day);
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(key, n) {
  const date = parseKey(key);
  date.setUTCDate(date.getUTCDate() + n);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

// 0=日 … 6=土
export function weekdayOf(key) {
  return parseKey(key).getUTCDay();
}

// ---------- 平日/休日 ----------

// 年末年始(12/30〜1/3)
export function isYearEnd(key) {
  const [, m, d] = key.split("-").map(Number);
  return (m === 12 && d >= 30) || (m === 1 && d <= 3);
}

// holidays: 祝日の "yyyy-MM-dd" の配列または Set
export function dayTypeOf(key, holidays) {
  const w = weekdayOf(key);
  const isHoliday = holidays instanceof Set ? holidays.has(key) : holidays.indexOf(key) !== -1;
  return w === 0 || w === 6 || isHoliday || isYearEnd(key) ? "休日" : "平日";
}

// ---------- マスタ ----------

// DB の shift_master の行 → { code: { code, type, start: {平日, 休日, 平休, 休平}, end: {平日, 休日, 平休, 休平}, stay } }
//   平休 = 平日に泊 → 休日に非番 のときの出勤・退勤、休平 = 休日に泊 → 平日に非番 のときの出勤・退勤(どれも空でもよい)
export function indexMaster(rows) {
  const map = {};
  rows.forEach((r) => {
    map[r.code] = {
      code: r.code,
      type: r.kind,
      start: {
        平日: r.weekday_start || "",
        休日: r.holiday_start || "",
        平休: r.weekday_holiday_start || "",
        休平: r.holiday_weekday_start || "",
      },
      end: {
        平日: r.weekday_end || "",
        休日: r.holiday_end || "",
        平休: r.weekday_holiday_end || "",
        休平: r.holiday_weekday_end || "",
      },
      stay: r.stay || "",
    };
  });
  return map;
}

export function pickTime(times, dayType) {
  return times[dayType] || times["平日"] || "";
}

// 泊の日 → 非番の日 の平休が違うときの列の名前("平休" / "休平")。同じなら ""
export function crossOf(fromDayType, toDayType) {
  if (fromDayType === "平日" && toDayType === "休日") return "平休";
  if (fromDayType === "休日" && toDayType === "平日") return "休平";
  return "";
}

// 自動のメモ(1行目): 泊は出勤時間だけ、日勤は「出勤〜退勤」、休日はなし
// 泊の出勤は、泊の日(dayType)と翌日(nextDayType)の平休で列を選ぶ
//   平日に泊 → 翌日が休日: 平休出勤(空なら平日出勤) / 休日に泊 → 翌日が平日: 休平出勤(空なら休日出勤)
export function dutyMemo(entry, dayType, nextDayType) {
  if (!entry || entry.type === "休日") return "";
  const cross = entry.type === "泊" ? crossOf(dayType, nextDayType) : "";
  const start = (cross && entry.start[cross]) || pickTime(entry.start, dayType);
  const end = pickTime(entry.end, dayType);
  return entry.type === "日勤" && start && end ? start + "〜" + end : start;
}

// 非番の自動メモ: 前日の泊の退勤時間。泊の日(prevDayType)と非番の日(dayType)の平休で列を選ぶ
//   平日に泊 → 休日に非番: 平休退勤(空なら休日退勤)
//   休日に泊 → 平日に非番: 休平退勤(空なら平日退勤)
//   それ以外: 非番の日の平休の列
// 休日の列が空なら平日の列を使う(pickTime)
export function offdutyMemo(prevEntry, prevDayType, dayType) {
  const cross = crossOf(prevDayType, dayType);
  return (cross && prevEntry.end[cross]) || pickTime(prevEntry.end, dayType);
}

// 予定のメモ全体。泊なら2行目に泊地を付ける
export function describe(entry, firstLine) {
  const lines = [];
  if (firstLine) lines.push(firstLine);
  if (entry && entry.type === "泊" && entry.stay) lines.push(entry.stay);
  return lines.join("\n");
}

// ---------- 入力 ----------

export function normalizeEntry(raw) {
  if (!raw) return { code: "", memo: "" };
  if (typeof raw === "string") return { code: raw.trim(), memo: "" };
  return {
    code: String(raw.code || "").trim(),
    memo: String(raw.memo || "").trim(),
  };
}

export function codeOf(entry) {
  return normalizeEntry(entry).code;
}

// ---------- 予定の組み立て ----------

// 月内の入力から、保存する記録と登録する予定の一覧を作る。
//   entries        { "yyyy-MM-dd": { code, memo } }  (memo は手修正したときだけ)
//   prevLastCode   前月末の番号(1日が非番かどうかの判定用)
//   nextFirstEntry 翌月1日の記録(月末が泊なら非番のメモに、泊でなければ翌月1日の予定に使う)
//   master         indexMaster() の結果
//   holidays       祝日の配列または Set(前月末〜翌月2日を含める。泊の日と翌日の平休で出勤・退勤の列を選ぶため)
// 非番の日は番号を無視する。翌月1日の予定も含める(月末が泊なら非番、泊でなければ翌月1日の記録の予定)。
// 月末を泊から戻したとき、翌月1日の非番を消したあとに翌月1日の予定を作り直すため。
export function buildPlan({ year, month, entries, prevLastCode, nextFirstEntry, master, holidays }) {
  const days = daysInMonth(year, month);
  const cleanEntries = {};
  const events = [];

  for (let d = 1; d <= days + 1; d++) {
    const key = d > days ? addDays(dateKey(year, month, days), 1) : dateKey(year, month, d);
    const e = normalizeEntry(d > days ? nextFirstEntry : (entries || {})[key]);
    const dayType = dayTypeOf(key, holidays);

    const prevCode = d === 1 ? prevLastCode : codeOf(cleanEntries[dateKey(year, month, d - 1)]);
    const prevMaster = master[prevCode];
    if (prevMaster && prevMaster.type === "泊") {
      // 番号が残っている日のメモは、その番号(勤務の日)のためのものなので使わない
      // (前月末を泊にしたとき、翌月1日の記録に番号とメモが残っていることがある)
      const memo = e.code ? "" : e.memo;
      events.push({
        date: key,
        calendar: "work",
        kind: "offduty",
        title: OFFDUTY_TITLE,
        description: memo || offdutyMemo(prevMaster, dayTypeOf(addDays(key, -1), holidays), dayType),
      });
      if (d <= days && memo) {
        cleanEntries[key] = { code: "", memo };
      }
      continue;
    }
    if (!e.code && !e.memo) continue;
    if (d <= days) cleanEntries[key] = e;
    if (!e.code) continue;

    const entry = master[e.code];
    if (entry && entry.type === "休日") {
      events.push({ date: key, calendar: "holiday", kind: "day", title: e.code, description: e.memo });
    } else {
      events.push({
        date: key,
        calendar: "work",
        kind: "day",
        title: e.code,
        description: describe(entry, e.memo || dutyMemo(entry, dayType, dayTypeOf(addDays(key, 1), holidays))),
      });
    }
  }

  return { entries: cleanEntries, events: events };
}
