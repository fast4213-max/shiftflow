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
// 時間は、その日が土日祝・年末年始(12/30〜1/3)なら「休日」、それ以外は「平日」の列を使う(休日の列が空なら平日の列)。
// ただし泊の出勤と翌日の非番の退勤は、泊の日と翌日の平休が違えば「平休」「休平」の列を使う(空なら上と同じ)。
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

// from〜to(両端を含む)の平休を調べるのに、祝日の一覧が要る年の配列。
// 年末年始(12/30〜1/3)は一覧を見なくても休日と分かるので、その日だけが前の年・次の年にはみ出していても、その年は要らない
// (1月の登録が前の年の12/31を見るために、前の年の祝日を取りに行かないように)
export function holidayYearsFor(from, to) {
  const years = new Set();
  for (let key = from; key <= to; key = addDays(key, 1)) {
    if (!isYearEnd(key)) years.add(Number(key.slice(0, 4)));
  }
  return [...years];
}

// holidays: 祝日の "yyyy-MM-dd" の配列または Set
export function dayTypeOf(key, holidays) {
  const w = weekdayOf(key);
  const isHoliday = holidays instanceof Set ? holidays.has(key) : holidays.indexOf(key) !== -1;
  return w === 0 || w === 6 || isHoliday || isYearEnd(key) ? "休日" : "平日";
}

// ---------- マスタ ----------

// DB の shift_master の行 → { code: { code, type, start: {平日, 休日, 平休, 休平}, end: {平日, 休日, 平休, 休平}, stay, stayNextHoliday } }
//   平休 = 平日に泊 → 休日に非番 のときの出勤・退勤、休平 = 休日に泊 → 平日に非番 のときの出勤・退勤(どれも空でもよい)
export function indexMaster(rows) {
  // 手入力の番号が constructor・toString・__proto__ などでも、マスタにある番号と間違えないよう、継承の無い連想配列にする
  const map = Object.create(null);
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
      stayNextHoliday: r.stay_next_holiday || "", // 翌休泊: 泊の翌日(非番の日)が休日のときの泊地(空なら stay)
    };
  });
  return map;
}

// ---------- マスタの切替(ダイヤ改正・ダイヤ修正) ----------
// 区所のマスタは切替日ごとにある(master_periods)。ある日に使うマスタは、その日以前に始まったうちの最新。
// いちばん古いマスタは、切替日より前の日にも使う(始まりの日は表示のためのもの)。
// 切替日の前日の泊は、泊の日(出勤・泊地)は前のマスタ、非番の日(退勤)は新しいマスタの同じ番号を使う(buildPlan)。

export class MasterSet {
  // periods: master_periods の行 [{ id, starts_on, name }]、rows: shift_master の行(period_id 付き。sort_order の順)
  constructor(periods, rows) {
    this.periods = (periods || [])
      .map((p) => {
        const list = (rows || []).filter((r) => r.period_id === p.id);
        return { id: p.id, from: p.starts_on, name: p.name || "", rows: list, map: indexMaster(list) };
      })
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }

  // その日に使うマスタ({ id, from, name, rows, map })。切替日が1つも無ければ空のマスタ
  periodOn(key) {
    let found = this.periods[0];
    for (const p of this.periods) if (p.from <= key) found = p;
    return found || EMPTY_PERIOD;
  }

  // その日のマスタが、切替日だけ決まっていて行がまだ無い(CSV が未登録)か。
  // いちばん古いマスタが空なのは、区所のマスタが空なだけ(今までと同じく、番号は手入力として入る)
  missingOn(key) {
    const p = this.periodOn(key);
    return p !== this.periods[0] && p.rows.length === 0;
  }

  // from〜to(両端を含む)の間に始まる切替日
  startsBetween(from, to) {
    return this.periods.filter((p, i) => i > 0 && p.from >= from && p.from <= to);
  }
}

const EMPTY_PERIOD = { id: null, from: "", name: "", rows: [], map: Object.create(null) };

// その日に使うマスタ(indexMaster の形)。master が MasterSet でなければ(切替の無いマスタ)そのまま
export function masterOn(master, key) {
  return master instanceof MasterSet ? master.periodOn(key).map : master;
}

// 「2027年3月 ダイヤ改正」(名前が無ければ「2027年3月14日からのマスタ」)
export function periodLabel(period) {
  if (!period || !period.from) return "マスタ";
  const [y, m, d] = period.from.split("-").map(Number);
  return period.name ? y + "年" + m + "月 " + period.name : y + "年" + m + "月" + d + "日からのマスタ";
}

// "2027-03-14" → "3/14"
export function shortDate(key) {
  const [, m, d] = key.split("-").map(Number);
  return m + "/" + d;
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

// 泊地。泊の翌日(nextDayType)が休日で「翌休泊」があれば、そちら(「翌土休日は○○泊り」のような行路)
export function stayOf(entry, nextDayType) {
  if (!entry || entry.type !== "泊") return "";
  return (nextDayType === "休日" && entry.stayNextHoliday) || entry.stay || "";
}

// 予定のメモ全体。泊なら2行目に泊地を付ける(nextDayType は泊の翌日の平休。翌休泊を選ぶため)
export function describe(entry, firstLine, nextDayType) {
  const lines = [];
  if (firstLine) lines.push(firstLine);
  const stay = stayOf(entry, nextDayType);
  if (stay) lines.push(stay);
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
//   master         indexMaster() の結果、または切替のあるマスタ(MasterSet。日ごとに、その日のマスタを引く)
//   holidays       祝日の配列または Set(前月末〜翌月2日を含める。泊の日と翌日の平休で出勤・退勤の列を選ぶため)
// 非番の日は番号を無視する。翌月1日の予定も含める(月末が泊なら非番、泊でなければ翌月1日の記録の予定)。
// 月末を泊から戻したとき、翌月1日の非番を消したあとに翌月1日の予定を作り直すため。
// errors: マスタの切替で登録できない日 [{ date, message, kind, period }](空でなければ登録しない。保存はできる)
//   kind: "missing"(その日に番号があるのに、その日のマスタの CSV がまだ無い。period はその切替日) /
//         "offduty-missing"(切替日の前日の泊で、非番の日のマスタの CSV がまだ無い) / "offduty"(新しいマスタに同じ番号の泊が無い)
//   - 切替日から後の日に番号があるのに、その切替日のマスタがまだ無い
//   - 切替日の前日の泊で、非番の日(切替日)のマスタがまだ無い
//   - 切替日の前日の泊で、新しいマスタに同じ番号の泊が無く、非番の日のメモ(退勤時間)も無い
export function buildPlan({ year, month, entries, prevLastCode, nextFirstEntry, master, holidays }) {
  const days = daysInMonth(year, month);
  const cleanEntries = {};
  const events = [];
  const errors = [];

  for (let d = 1; d <= days + 1; d++) {
    const key = d > days ? addDays(dateKey(year, month, days), 1) : dateKey(year, month, d);
    const e = normalizeEntry(d > days ? nextFirstEntry : (entries || {})[key]);
    const dayType = dayTypeOf(key, holidays);
    const prevKey = addDays(key, -1);

    const prevCode = d === 1 ? prevLastCode : codeOf(cleanEntries[prevKey]);
    const prevMaster = masterOn(master, prevKey)[prevCode];
    if (prevMaster && prevMaster.type === "泊") {
      // 番号が残っている日のメモは、その番号(勤務の日)のためのものなので使わない
      // (前月末を泊にしたとき、翌月1日の記録に番号とメモが残っていることがある)
      const memo = e.code ? "" : e.memo;
      const off = offdutyEntryOf(master, prevKey, key, prevCode, d > days);
      if (off.error && (off.missing || !memo)) {
        errors.push({ date: prevKey, message: off.error, kind: off.missing ? "offduty-missing" : "offduty", period: off.missing ? master.periodOn(key) : null });
      }
      events.push({
        date: key,
        calendar: "work",
        kind: "offduty",
        title: OFFDUTY_TITLE,
        description: memo || (off.entry ? offdutyMemo(off.entry, dayTypeOf(prevKey, holidays), dayType) : ""),
      });
      if (d <= days && memo) {
        cleanEntries[key] = { code: "", memo };
      }
      continue;
    }
    if (!e.code && !e.memo) continue;
    if (d <= days) cleanEntries[key] = e;
    if (!e.code) continue;

    if (master instanceof MasterSet && master.missingOn(key)) {
      // 翌月1日の記録(翌月の入力)は、翌月の登録で確かめる。翌月1日のマスタがまだ無いときは、翌月1日の予定を作り直さない
      // (この月の登録で、時間の無い予定に作り直してしまうため。翌月の登録に任せる。AB3)
      if (d > days) continue;
      errors.push({ date: key, message: missingMessage(master.periodOn(key), key), kind: "missing", period: master.periodOn(key) });
    }
    const entry = masterOn(master, key)[e.code];
    if (entry && entry.type === "休日") {
      events.push({ date: key, calendar: "holiday", kind: "day", title: e.code, description: e.memo });
    } else {
      const nextDayType = dayTypeOf(addDays(key, 1), holidays);
      events.push({
        date: key,
        calendar: "work",
        kind: "day",
        title: e.code,
        description: describe(entry, e.memo || dutyMemo(entry, dayType, nextDayType), nextDayType),
      });
    }
  }

  return { entries: cleanEntries, events: events, errors: errors };
}

// 泊の翌日(非番の日 key)の退勤時間に使うマスタの行。泊の日(prevKey)と同じマスタなら、その泊の行。
// 切替日の前日の泊なら、非番の日(切替日)のマスタの同じ番号の泊。
//   { entry, error, missing }  entry が null なら、退勤時間はマスタから分からない(error に理由)。
//   missing: 非番の日のマスタがまだ無い(メモに退勤時間を書いても登録できない)
//   nextMonth: 非番の日が翌月(月末の泊)。メモは翌月の画面で入れるので、そう書く
export function offdutyEntryOf(master, prevKey, key, prevCode, nextMonth = false) {
  const prev = masterOn(master, prevKey)[prevCode] || null;
  if (!(master instanceof MasterSet)) return { entry: prev, error: "", missing: false };
  const from = master.periodOn(prevKey);
  const to = master.periodOn(key);
  if (from === to) return { entry: prev, error: "", missing: false };
  const label = periodLabel(to) + "(" + shortDate(to.from) + "〜)";
  if (master.missingOn(key)) {
    return {
      entry: null,
      missing: true,
      error: shortDate(prevKey) + "の泊(" + prevCode + ")の非番の退勤時間が分かりません。" + label +
        "のマスタがまだ登録されていないためです(管理者がマスタを入れると登録できます)。",
    };
  }
  const next = to.map[prevCode];
  if (next && next.type === "泊") return { entry: next, error: "", missing: false };
  return {
    entry: null,
    missing: false,
    error: shortDate(prevKey) + "の泊(" + prevCode + ")の非番の退勤時間が、" + label + "のマスタにありません(同じ番号の泊がありません)。" +
      (nextMonth ? "この月を「保存」してから、翌月の画面で、" : "") + shortDate(key) + "(非番)のメモに退勤時間(例 9:00)を入れてください。",
  };
}

function missingMessage(period, key) {
  return shortDate(key) + ": " + periodLabel(period) + "(" + shortDate(period.from) + "〜)のマスタがまだ登録されていません。" +
    shortDate(period.from) + "から後の日は、管理者がマスタを入れるまで番号を入れて登録できません。";
}
