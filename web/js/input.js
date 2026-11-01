// 勤務入力画面
import { friendlyText, $, callFunction, requireLogin, selectAllPages, supabase } from "./app.js?v=dev";
import {
  addDays, buildPlan, dateKey, dayTypeOf, daysInMonth, describe, dutyMemo, holidayYearsFor, MasterSet, masterOn, offdutyEntryOf, offdutyMemo, pad,
  periodLabel, shortDate,
} from "./plan.js?v=dev";
import { PHOTO_IMPORT_URL } from "./config.js?v=dev";
import { captureImportFromHash, decodeImport, stashImport, takePendingImport } from "./photo-import.js?v=dev";

// 写真取込のリンク(input.html#import=…)で開いたときは、ログインを確かめる前に取込の文字を覚えて、アドレスから消す
captureImportFromHash();

const MANUAL = "__manual__";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 今日・今月は、画面を開きっぱなしにして日付や月が変わっても合うよう、使うたびに調べる
function nowParts() {
  const t = new Date();
  return { year: t.getFullYear(), month: t.getMonth() + 1, key: dateKey(t.getFullYear(), t.getMonth() + 1, t.getDate()) };
}
const state = {
  year: nowParts().year,
  month: nowParts().month,
  master: new MasterSet([], []), // 区所のマスタ(切替日 = ダイヤ改正・ダイヤ修正ごと)。日ごとに masterOn で引く
  entries: {},       // { "yyyy-MM-dd": { code, memo } }  memo は手修正したときだけ
  prevLastCode: "",
  nextFirstEntry: null, // 翌月1日の記録(月末の泊の非番のメモ。サーバーと同じに、登録できない日を調べるため)
  savedLastCode: "",    // 保存・登録してある月末の番号(サーバーが「月末を今回はじめて泊にした」かを見るのと同じ判断をするため。AB2)
  officeId: null,
  holidays: [],
  offduty: new Map(), // 表示中の非番の日(番号を変えたとき、非番になった・非番でなくなった日を調べるため)
  dirty: false,
  edits: 0,          // 書き換えた回数。登録中に書き換えた分を「登録済み」にしないため
  loadId: 0,         // 読み込みの番号。月を続けて移動したとき、古い月の結果で上書きしないため
  registering: false,
  saving: false,
  imported: new Set(), // 写真取込で入れた日("yyyy-MM-dd")。保存・登録・月の移動で消す
};

// 今月より前には戻れない(今月かそれ以前の月を見ているとき)
function isFirstMonth() {
  const now = nowParts();
  return state.year * 12 + state.month <= now.year * 12 + now.month;
}

function setStatus(text, isError) {
  $("status").textContent = friendlyText(text);
  $("status").className = isError ? "error" : "";
}

// 祝日: キャッシュが無い年だけ Edge Function に取りに行かせる
// first は前月末から(1日が非番のとき、泊の日の平休を見るため)。nextFirst は月末が泊のとき翌日の平休を見るため
async function loadHolidays(first, nextFirst) {
  const years = holidayYearsFor(first, nextFirst); // 年末年始にはみ出すだけの年は要らない
  const { data: cached, error } = await supabase.from("holiday_years").select("year").in("year", years);
  if (error) throw error;
  if ((cached || []).length < years.length) {
    const result = await callFunction("sync-holidays", { years }, { timeoutMs: 60000 });
    return result.holidays.filter((d) => d >= first && d <= nextFirst);
  }
  const { data, error: e2 } = await supabase.from("holidays").select("date").gte("date", first).lte("date", nextFirst);
  if (e2) throw e2;
  return (data || []).map((r) => r.date);
}

async function load() {
  const id = ++state.loadId;
  setStatus("読み込み中…");
  try {
    await loadMonth(id);
  } catch (err) {
    if (id === state.loadId) setStatus(err.message || String(err), true);
  }
}

// 非番の日(前の日が泊)に残っている番号とメモを消す。戻り値は無い
function clearOffdutyEntries() {
  offdutyDays().forEach((_, key) => {
    const e = state.entries[key];
    if (e && (e.code || "").trim()) state.entries[key] = { code: "", memo: "" };
  });
}

async function loadMonth(id) {
  $("title").textContent = state.year + "年" + state.month + "月";
  $("prev").disabled = isFirstMonth();
  $("register").disabled = true;
  $("save").disabled = true;
  $("list").innerHTML = "";
  state.imported = new Set();
  // 読み込みが終わるまでは前の月の入力が残っているので、登録で送らないよう空にしておく
  state.entries = {};

  const first = dateKey(state.year, state.month, 1);
  const last = dateKey(state.year, state.month, daysInMonth(state.year, state.month));
  const prevLast = addDays(first, -1);
  const nextFirst = addDays(last, 1);
  // マスタは切替日(ダイヤ改正・ダイヤ修正)ごとに読む。日ごとに、その日のマスタを使う
  // マスタの行は全部の切替日の分なので、上限(1,000行)を超えても欠けないよう分けて読む(AB14)
  const [periodsRes, masterRows, recordsRes, holidays] = await Promise.all([
    supabase.from("master_periods").select("id, starts_on, name").eq("office_id", state.officeId),
    selectAllPages((from, to) =>
      supabase.from("shift_master").select("*").eq("office_id", state.officeId)
        .order("period_id").order("sort_order").order("code").range(from, to)
    ),
    supabase.from("shift_records").select("date, code, memo").gte("date", prevLast).lte("date", nextFirst),
    loadHolidays(prevLast, nextFirst),
  ]);
  if (id !== state.loadId) return; // 読み込み中に別の月へ移動した
  if (periodsRes.error) throw periodsRes.error;
  if (recordsRes.error) throw recordsRes.error;

  state.master = new MasterSet(periodsRes.data || [], masterRows);
  state.entries = {};
  state.prevLastCode = "";
  state.nextFirstEntry = null;
  (recordsRes.data || []).forEach((r) => {
    if (r.date === prevLast) state.prevLastCode = r.code;
    else if (r.date === nextFirst) state.nextFirstEntry = { code: r.code, memo: r.memo };
    else state.entries[r.date] = { code: r.code, memo: r.memo };
  });
  state.savedLastCode = ((state.entries[last] || {}).code || "").trim();
  state.holidays = holidays;
  // 非番の日に番号が残っていたら(前の月の月末を泊にしたときの1日など)、番号とメモを消す。
  // 登録でもサーバーが消す。残しておくと、非番のメモに前の番号のメモが出てしまうため
  clearOffdutyEntries();
  state.dirty = false;
  // その日のマスタに無い番号を、一覧の番号に合わせ直す(新しいマスタの CSV が入る前に入れた「1」→「特1」・全角など。AB5)。
  // 合わせ直して泊になると翌日が非番になるので、もう一度片付ける(AD7)
  const matched = matchSavedCodes();
  if (matched.length) {
    state.dirty = true;
    clearOffdutyEntries();
  }
  render();
  scrollToToday();
  $("register").disabled = false;
  $("save").disabled = false;
  $("reset").disabled = false;
  const hasMaster = state.master.periods.some((p) => p.rows.length);
  if (!hasMaster) setStatus("この区所の勤務の番号の一覧(マスタ)が空です。管理者に登録を頼んでください。", true);
  else if (matched.length) setStatus("一覧の番号に合わせました: " + matched.join("、") + "。まだ保存・登録していません。確かめて「登録」か「保存」を押してください。");
  else setStatus("");
}

// 番号がその日のマスタに無いとき、一覧の番号に合わせられれば合わせる。合わせた日の一覧(「3日「1」→「特1」」)を返す
function matchSavedCodes() {
  const matched = [];
  const offduty = offdutyDays();
  Object.entries(state.entries).forEach(([key, e]) => {
    const code = (e.code || "").trim();
    if (!code || offduty.has(key) || masterAt(key)[code]) return;
    const found = masterCodeOf(code, key);
    if (found && found !== code) {
      e.code = found;
      matched.push(Number(key.slice(8)) + "日「" + code + "」→「" + found + "」");
    }
  });
  return matched;
}

// その日に使うマスタ(番号 → 行)と、その日の番号の一覧(並び順)
function masterAt(key) {
  return masterOn(state.master, key);
}

function masterRowsAt(key) {
  return state.master.periodOn(key).rows;
}

// 手入力した番号が、その日(key)の一覧にあれば、一覧の番号を返す(無ければ "")。
// 全角の英数字は半角にして比べる(スマホの日本語キーボードで「１０１」と入っても、一覧の「101」として扱うため)
function masterCodeOf(value, key) {
  const half = (s) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  const typed = value.trim();
  const list = masterRowsAt(key);
  const found = list.find((m) => m.code === typed) ||
    list.find((m) => half(m.code) === half(typed));
  if (found) return found.code;
  // 数字だけで一覧に無いときは、頭に文字が付いた番号(勤務表の「1」→ 一覧の「特1」など)が1つだけあれば、それにする。
  // 「特1」と「臨1」のように2つ以上あるときは、どれか決められないので手入力のまま
  const digits = half(typed);
  if (!/^\d+$/.test(digits)) return "";
  const prefixed = list.filter((m) => {
    const hit = half(m.code).match(/^(\D+)(\d+)$/);
    return hit && hit[2] === digits;
  });
  return prefixed.length === 1 ? prefixed[0].code : "";
}

function entryOf(key) {
  if (!state.entries[key]) state.entries[key] = { code: "", memo: "" };
  return state.entries[key];
}

// 非番の日 → 前日の泊の番号。前日の番号で、前日のマスタを見て決める(非番の日は番号なし扱い。サーバーの buildPlan と同じ判定)。
// 非番の日の番号は無視する(登録時もサーバーが無視する)。番号を変えて非番になった日の番号は codeChanged で消す
function offdutyDays() {
  const days = new Map();
  let prevCode = state.prevLastCode;
  for (let d = 1; d <= daysInMonth(state.year, state.month); d++) {
    const key = dateKey(state.year, state.month, d);
    const prevMaster = masterAt(addDays(key, -1))[prevCode];
    const offduty = !!(prevMaster && prevMaster.type === "泊");
    if (offduty) days.set(key, prevCode);
    prevCode = offduty ? "" : ((state.entries[key] || {}).code || "").trim();
  }
  return days;
}

function render() {
  const { year, month } = state;
  const list = $("list");
  list.innerHTML = "";
  state.offduty = offdutyDays();
  const errors = renderPeriodNote();

  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const key = dateKey(year, month, d);
    const e = entryOf(key);
    const dayType = dayTypeOf(key, state.holidays);
    const weekday = new Date(year, month - 1, d).getDay();

    const offduty = state.offduty.has(key);

    const tr = document.createElement("tr");
    if (key === nowParts().key) tr.classList.add("today");
    const imported = state.imported.has(key);
    if (imported) tr.classList.add("imported");
    if (errors.has(key)) {
      tr.classList.add("period-error");
      tr.title = errors.get(key);
    }

    const dayTd = document.createElement("td");
    dayTd.className = "day";
    dayTd.textContent = d;
    tr.appendChild(dayTd);

    const weekdayTd = document.createElement("td");
    weekdayTd.className = "weekday" + (dayType === "休日" ? " red" : "");
    weekdayTd.textContent = WEEKDAYS[weekday];
    tr.appendChild(weekdayTd);

    // 平/休: 土日祝・年末年始(12/30〜1/3)で自動。表示のみ
    const typeTd = document.createElement("td");
    typeTd.className = "type";
    const typeLabel = document.createElement("span");
    typeLabel.textContent = dayType === "休日" ? "休" : "平";
    typeLabel.className = dayType === "休日" ? "holiday" : "";
    typeTd.appendChild(typeLabel);
    tr.appendChild(typeTd);

    const codeTd = document.createElement("td");
    codeTd.className = "code";
    tr.appendChild(codeTd);

    let autoMemo = "";
    let stay = "";
    if (offduty) {
      const span = document.createElement("span");
      span.className = "offduty";
      span.textContent = "非番";
      codeTd.appendChild(span);
      // 退勤時間は非番の日のマスタから(切替日の前日の泊は、新しいマスタの同じ番号。無ければ空で、メモに入れてもらう)
      const off = offdutyEntryOf(state.master, addDays(key, -1), key, state.offduty.get(key));
      autoMemo = off.entry ? offdutyMemo(off.entry, dayTypeOf(addDays(key, -1), state.holidays), dayType) : "";
    } else {
      // 番号は前後の空白を除いて見る(登録時もサーバーが除く)
      const code = e.code.trim();
      const entry = masterAt(key)[code];
      const isManual = !!e.code && !entry;
      const pick = document.createElement("button");
      pick.className = "pick";
      pick.textContent = isManual ? "手入力" : code;
      pick.addEventListener("click", () => {
        openPicker(d + "(" + WEEKDAYS[weekday] + ")", key, isManual ? MANUAL : code, (value) => {
          e.code = value === MANUAL ? " " : value;
          e.memo = "";
          codeChanged();
          if (value === MANUAL) list.children[d - 1].querySelector(".code input").focus();
        });
      });
      codeTd.appendChild(pick);

      if (isManual) {
        const input = document.createElement("input");
        input.maxLength = 30;
        input.value = code;
        input.placeholder = "入力";
        input.addEventListener("input", () => {
          // 空欄でも手入力モードを保つため空白1文字を入れておく(登録時は無視される)
          e.code = input.value || " ";
          edited();
        });
        // 入れ終えたとき、一覧にある番号なら(全角で入れても)、その番号として表示し直す
        // (登録ではサーバーが一覧の番号として扱う。泊なら翌日が非番になる)
        input.addEventListener("change", () => {
          const value = masterCodeOf(input.value, key);
          if (!value) return;
          e.code = value;
          codeChanged();
        });
        codeTd.appendChild(input);
      } else if (entry) {
        autoMemo = dutyMemo(entry, dayType, dayTypeOf(addDays(key, 1), state.holidays));
        // 泊地はメモの2行目としてカレンダーに入る(画面ではメモ欄の下に表示)。翌日が休日なら翌休泊
        stay = describe(entry, "", dayTypeOf(addDays(key, 1), state.holidays));
      }
    }

    // メモ: 番号を選ぶと自動で入る。手で書き換えも可
    const memoTd = document.createElement("td");
    memoTd.className = "memo";
    const memoInput = document.createElement("input");
    memoInput.maxLength = 200;
    memoInput.value = e.memo || autoMemo;
    memoInput.placeholder = autoMemo;
    if (e.memo) memoInput.className = "override";
    memoInput.addEventListener("input", () => {
      const value = memoInput.value.trim();
      e.memo = value === autoMemo ? "" : value;
      memoInput.className = e.memo ? "override" : "";
      edited();
    });
    // 写真取込で入った、一覧にない番号(変・臨時など)で時間が空の日は、メモに時間を入れるよう目立たせる。
    // 前のマスタにはあって、その日のマスタ(切替日から後の新しいマスタ)で無くなった番号も同じ(手入力になり、時間が入らないため)
    const dropped = !offduty && droppedCode(key, e.code.trim());
    const needTime = () => (imported || dropped) && !offduty && !!e.code.trim() && !masterAt(key)[e.code.trim()] &&
      !/^[〜~\-ー—]$|休/.test(e.code.trim()) && !e.memo;
    if (needTime()) {
      tr.classList.add("needtime");
      memoInput.placeholder = "時間 例 9:00〜17:45";
    }
    memoInput.addEventListener("input", () => tr.classList.toggle("needtime", needTime()));
    memoTd.appendChild(memoInput);
    if (stay) {
      const stayLabel = document.createElement("span");
      stayLabel.className = "stay";
      stayLabel.textContent = stay;
      memoTd.appendChild(stayLabel);
    }
    tr.appendChild(memoTd);

    list.appendChild(tr);
  }
}

// 前のマスタにはあって、その日のマスタで無くなった番号か(切替日から後の日)。
// その日のマスタの CSV がまだ無いときは数えない(そのときは登録できない日として赤くなる。AB6)
function droppedCode(key, code) {
  if (!code || state.master.missingOn(key)) return false;
  const i = state.master.periods.indexOf(state.master.periodOn(key));
  return i > 0 && !state.master.periods[i].map[code] && !!state.master.periods[i - 1].map[code];
}

// マスタの切替(ダイヤ改正・ダイヤ修正)がこの月にあれば、一覧の上に知らせる。
// 登録できない日(切替日のマスタがまだ無い・新しいマスタに同じ泊が無い)も、サーバーと同じ buildPlan で調べて並べる。
// 戻り値: 登録できない日 → 理由(その行を赤くする)
function renderPeriodNote() {
  const { year, month } = state;
  const first = dateKey(year, month, 1);
  const nextFirst = addDays(dateKey(year, month, daysInMonth(year, month)), 1);
  const note = $("period-note");
  note.innerHTML = "";
  const add = (text, isError) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (isError) p.className = "error";
    note.appendChild(p);
  };
  state.master.startsBetween(first, nextFirst).forEach((p) => {
    const when = p.from === nextFirst ? "翌月1日" : Number(p.from.slice(8)) + "日";
    add(when + "から「" + periodLabel(p) + "」のマスタになります" + (p.rows.length
      ? "(前の日の泊の、非番の退勤時間も新しいマスタから入ります)。"
      : "。まだ管理者がマスタを入れていないので、" + shortDate(p.from) + "から後の日と、前の日の泊は登録できません(保存はできます)。"), false);
  });
  // 新しいマスタで無くなった番号を入れてある日(手入力になって時間が入らない。行は黄色)
  const dropped = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const key = dateKey(year, month, d);
    const code = ((state.entries[key] || {}).code || "").trim();
    // メモ(時間)を入れた日は数えない(案内どおりに入れたら消えるように。AB6)
    if (!state.offduty.has(key) && !(state.entries[key] || {}).memo && droppedCode(key, code)) dropped.push(d + "日の「" + code + "」");
  }
  if (dropped.length) {
    add("新しいマスタに無い番号があります: " + dropped.join("、") + "。手入力として登録されるので、メモに時間を入れるか、番号を選び直してください。", false);
  }
  const errors = periodErrors();
  // 前の月の月末の泊のエラーは、メモを入れる1日の行に付ける(AB8)。
  // 月の途中の泊で、非番の退勤時間が分からないエラーも、メモを入れる非番の日(翌日)の行に付ける(AD8。月末の泊は翌月の画面で入れるので、月末の行)
  const lastDay = addDays(nextFirst, -1);
  const byDate = new Map();
  errors.forEach((e) => {
    const next = addDays(e.date, 1);
    const key = e.date < first ? first : e.kind === "offduty" && next <= lastDay ? next : e.date;
    if (!byDate.has(key)) byDate.set(key, e.message);
  });
  // CSV がまだ無い日のエラーは、切替日ごとに1行にまとめる(1日1行だと長くなるため。AB7)
  const missing = new Map();
  errors.filter((e) => e.kind === "missing").forEach((e) => {
    if (!missing.has(e.period.from)) missing.set(e.period.from, { period: e.period, days: [] });
    missing.get(e.period.from).days.push(e.date);
  });
  missing.forEach(({ period, days }) => {
    const range = days.length > 1 ? shortDate(days[0]) + "〜" + shortDate(days[days.length - 1]) + " の" + days.length + "日" : shortDate(days[0]);
    add(range + ": 「" + periodLabel(period) + "」(" + shortDate(period.from) + "〜)のマスタがまだ登録されていません。管理者がマスタを入れるまで、番号のある日は登録できません(保存はできます)。", true);
  });
  [...new Set(errors.filter((e) => e.kind !== "missing").map((e) => e.message))].forEach((m) => add(m, true));
  note.hidden = !note.childElementCount;
  return byDate;
}

// 登録できない日(サーバーの register-month と同じ判断)。
// 月末を今回はじめて泊にしたときは、翌月1日の番号の無いメモ(別の用事のメモ)を非番のメモに使わない(W6。AB2)
function periodErrors() {
  const { year, month } = state;
  const last = dateKey(year, month, daysInMonth(year, month));
  const nextFirst = addDays(last, 1);
  const planOf = (nextFirstEntry) => buildPlan({
    year, month, entries: state.entries, prevLastCode: state.prevLastCode, nextFirstEntry, master: state.master, holidays: state.holidays,
  });
  const plan = planOf(state.nextFirstEntry);
  const nextFirstOffduty = plan.events.some((e) => e.date === nextFirst && e.kind === "offduty");
  const savedLast = masterAt(last)[state.savedLastCode];
  const newly = nextFirstOffduty && !(savedLast && savedLast.type === "泊");
  if (newly && state.nextFirstEntry && !(state.nextFirstEntry.code || "").trim()) return planOf({ code: "", memo: "" }).errors;
  return plan.errors;
}

// 保存・登録のあと: サーバーが片付けた翌月1日の記録を読み直し、保存した月末の番号を覚える(AB2)
async function afterSaved() {
  const { year, month } = state;
  const last = dateKey(year, month, daysInMonth(year, month));
  state.savedLastCode = state.offduty.has(last) ? "" : ((state.entries[last] || {}).code || "").trim();
  const { data, error } = await supabase.from("shift_records").select("code, memo").eq("date", addDays(last, 1)).maybeSingle();
  if (error || year !== state.year || month !== state.month) return;
  state.nextFirstEntry = data ? { code: data.code, memo: data.memo } : null;
  refreshPeriodErrors();
}

function edited() {
  state.dirty = true;
  state.edits++;
  refreshPeriodErrors();
}

// 書いている途中(メモ・手入力の番号)でも、登録できない日の知らせと赤い行を合わせる(一覧は作り直さない。入力中の欄が消えないように)
function refreshPeriodErrors() {
  const errors = renderPeriodNote();
  [...$("list").children].forEach((tr, i) => {
    const key = dateKey(state.year, state.month, i + 1);
    tr.classList.toggle("period-error", errors.has(key));
    tr.title = errors.get(key) || "";
  });
}

function changed() {
  edited();
  render();
}

// 番号を変えたあと。前日の泊が変わって非番になった日・非番でなくなった日の手修正メモは、
// 前の状態(勤務の日・非番の日)のためのものなので消して、自動の値に戻す。
// 非番になった日の番号も消す(登録してもサーバーが消す)。残しておくと、泊を1日前へ入れ直したとき
// (5日を泊にしたあと4日を泊にし、さらに3日を泊にするなど)、上書きしたはずの番号が戻ってしまうため
function codeChanged() {
  const before = state.offduty;
  const after = offdutyDays();
  after.forEach((_, key) => {
    if (!before.has(key) && state.entries[key]) state.entries[key].code = "";
  });
  new Set([...before.keys(), ...after.keys()]).forEach((key) => {
    if (before.has(key) !== after.has(key) && state.entries[key]) state.entries[key].memo = "";
  });
  changed();
}

function scrollToToday() {
  const row = document.querySelector("#list tr.today");
  if (row) row.scrollIntoView({ block: "center" });
  else window.scrollTo(0, 0);
}

// 番号の選択: 一覧をボタンのグリッドで出す(プルダウンだと縦に長いため)
let onPick = null;

// 一覧は、その日(key)のマスタの番号(切替日から後の日は、新しいマスタの番号)
function openPicker(title, key, current, callback) {
  onPick = callback;
  $("picker-title").textContent = title;
  // 切替日から後で、新しいマスタがまだ無い日は、一覧が空になるので理由を出す
  const period = state.master.periodOn(key);
  $("picker-note").hidden = !state.master.missingOn(key);
  $("picker-note").textContent = state.master.missingOn(key)
    ? shortDate(period.from) + "からの「" + periodLabel(period) + "」のマスタが、まだ登録されていません(管理者が入れるまで、この日は登録できません)。"
    : "";
  [["picker-duty", (m) => m.kind !== "休日"], ["picker-off", (m) => m.kind === "休日"]].forEach(([id, match]) => {
    const grid = $(id);
    grid.innerHTML = "";
    masterRowsAt(key).filter(match).forEach((m) => {
      const button = document.createElement("button");
      button.textContent = m.code;
      button.className = (m.kind === "休日" ? "holiday" : "") + (m.code === current ? " current" : "");
      button.addEventListener("click", () => pick(m.code));
      grid.appendChild(button);
    });
  });
  $("picker").showModal();
  $("picker").scrollTop = 0;
}

function pick(value) {
  $("picker").close();
  if (onPick) onPick(value);
  onPick = null;
}

$("picker-manual").addEventListener("click", () => pick(MANUAL));
$("picker-clear").addEventListener("click", () => pick(""));
$("picker-cancel").addEventListener("click", () => {
  onPick = null;
  $("picker").close();
});

function moveMonth(delta) {
  if (state.registering || state.saving) return;
  if (delta < 0 && isFirstMonth()) return;
  if (state.dirty && !confirm("登録していない変更があります。移動しますか？")) return;
  const date = new Date(state.year, state.month - 1 + delta, 1);
  state.year = date.getFullYear();
  state.month = date.getMonth() + 1;
  load();
}

$("prev").addEventListener("click", () => moveMonth(-1));
$("next").addEventListener("click", () => moveMonth(1));

// リンクの確認で「移る」と決めた印(beforeunload でもう一度聞かないため)。
// 変更なし(dirty=false)にはしない: Claude のアプリが開くだけで、この画面が残ることがあるため(AA9)
let leaveConfirmed = false;
const clearLeaveConfirmed = () => { leaveConfirmed = false; };
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") clearLeaveConfirmed(); });
window.addEventListener("pageshow", clearLeaveConfirmed);

window.addEventListener("beforeunload", (ev) => {
  if (!state.dirty || leaveConfirmed) return;
  ev.preventDefault();
  ev.returnValue = ""; // 古いブラウザは returnValue が無いと確認を出さない
});

// iPhone の Safari(ホーム画面に追加したアプリも)は、ページを離れるときの確認(beforeunload)を出さない。
// 上のナビ(設定・使い方・ログアウトなど)で移るときも、ここで確かめる
document.addEventListener("click", (ev) => {
  const link = ev.target.closest && ev.target.closest("a[href]");
  if (!link || !state.dirty) return;
  if (confirm("登録していない変更があります。移動しますか？")) {
    leaveConfirmed = true; // 移ると決めたので、beforeunload でもう一度聞かない
    ev.leaveConfirmed = true; // ログアウトの確認(app.js)で、続けて聞かない
    return;
  }
  ev.preventDefault();
  ev.stopPropagation(); // ログアウトのリンクの処理も止める
}, true);

$("register").addEventListener("click", async () => {
  const button = $("register");
  button.disabled = true;
  $("save").disabled = true;
  $("reset").disabled = true; // 登録とリセットが重ならないように(N2)
  // 登録中は月を移動できないようにする(移動先の月の入力と混ざらないように)
  state.registering = true;
  $("prev").disabled = true;
  $("next").disabled = true;
  setStatus("登録中…(30秒ほど、混んでいるときは2分ほどかかることがあります。そのままお待ちください)");
  const edits = state.edits;
  try {
    const result = await callFunction("register-month", {
      year: state.year,
      month: state.month,
      entries: state.entries,
    }, { timeoutMs: 150000 });
    // 登録中に書き換えた分は送っていないので、未登録のままにする(月の移動などで確認が出るように)
    const editedMeanwhile = state.edits !== edits;
    if (!editedMeanwhile) {
      state.dirty = false;
      clearImported();
    }
    setStatus(result.count + "件の予定を登録しました。" +
      (result.skipped ? "(休日用のカレンダーを設定していないため、休日の予定" + result.skipped + "件は登録していません)" : "") +
      (editedMeanwhile ? "登録中に変えたところは、まだ登録していません。もう一度「登録」を押してください。" : ""));
    if (!editedMeanwhile) afterSaved();
  } catch (err) {
    // 登録に失敗したら、カレンダーに反映できたとは言えないので、未登録の扱いにする(月の移動などで確認が出るように)。
    // 登録は「保存 → 今ある予定を削除 → 作り直し」の順なので、途中で失敗すると予定が欠けたままになる。
    // 何も変わっていない失敗(設定の不足・二重実行・ログイン切れ)には、この案内は付けない
    state.dirty = true;
    // (auth_unavailable・bad_entries・bad_period・holiday_unavailable も、保存の前に止まるので何も変わっていない。Q2・S23)
    const untouched = [
      "busy", "not_configured", "not_verified", "no_office", "unauthenticated", "not_member",
      "auth_unavailable", "bad_entries", "bad_period", "holiday_unavailable", "holiday_out_of_range", "master_period",
    ];
    setStatus(err.message + (untouched.includes(err.code)
      ? ""
      : "(入力は保存されています。カレンダーの予定が途中までになっていることがあるので、もう一度「登録」を押してください)"), true);
  } finally {
    state.registering = false;
    button.disabled = false;
    $("save").disabled = false;
    $("reset").disabled = false;
    $("prev").disabled = isFirstMonth();
    $("next").disabled = false;
  }
});

// 取り込んだ日の色を消す(保存・登録したあと)
function clearImported() {
  if (!state.imported.size) return;
  state.imported = new Set();
  render();
}

// 保存: カレンダーには入れず、入力だけを残す(臨時の時間などを、あとで調べて入れるため)。
// 登録と同じ register-month に saveOnly で送り、保存と翌月1日・2日の記録の片付けまでをサーバーで行う
// (先に保存だけすると、あとの登録で「登録する前の月末」が分からず片付けが効かなかったため。17回目の N1)
$("save").addEventListener("click", async () => {
  if (state.registering || state.saving) return;
  state.saving = true;
  $("save").disabled = true;
  $("register").disabled = true;
  $("reset").disabled = true; // 保存とリセットが重ならないように(N2)
  $("prev").disabled = true;
  $("next").disabled = true;
  setStatus("保存中…");
  const edits = state.edits;
  try {
    const result = await callFunction("register-month", {
      year: state.year,
      month: state.month,
      entries: state.entries,
      saveOnly: true,
    }, { timeoutMs: 60000 });
    const editedMeanwhile = state.edits !== edits;
    if (!editedMeanwhile) {
      state.dirty = false;
      clearImported();
    }
    // マスタの切替で登録できない日があっても、保存はできる(登録はマスタが入ってから)
    setStatus("保存しました。カレンダーにはまだ入っていません。" +
      (result && result.periodError ? "今は登録できません: " + result.periodError : "入れるときは「登録」を押してください。") +
      (editedMeanwhile ? "保存中に変えたところは、まだ保存していません。" : ""));
    if (!editedMeanwhile) afterSaved();
  } catch (err) {
    setStatus("保存できませんでした。" + (err.message || String(err)), true);
  } finally {
    state.saving = false;
    $("save").disabled = false;
    $("register").disabled = false;
    $("reset").disabled = false;
    $("prev").disabled = isFirstMonth();
    $("next").disabled = false;
  }
});

// ---------- ほかの画面で変わったとき ----------
// 写真取込(Claude のアプリや簡易ブラウザで開く)から戻ったときなど、この画面が隠れていた間に、ほかの画面で
// 保存・登録されていることがある。古い入力のまま「登録」すると上書きしてしまうので、画面に戻ったときに、
// 登録していない変更が無ければ読み直す。変更があるときは読み直さず、古いかもしれないと知らせる(L1)
const RELOAD_AFTER_HIDDEN_MS = 2000;
let hiddenAt = 0;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt && Date.now() - hiddenAt >= RELOAD_AFTER_HIDDEN_MS;
  hiddenAt = 0;
  if (!away || !state.officeId || state.registering || state.saving || $("register").disabled) return;
  // 番号の一覧・貼り付け・リセットの画面を開いているあいだは読み直さない
  // (読み直すと、開いている一覧で選んだ番号が、読み直す前の入力に入って消えるため。M1)
  if (document.querySelector("dialog[open]")) return;
  if (state.dirty) {
    // 取り込んだばかりの画面(この画面が新しい内容)では言わない。取込の案内を消さないように(M2)
    if (!state.imported.size) {
      setStatus("この画面には、登録していない変更があります。ほかの画面で保存・登録していたときは、この画面の内容は古いままです(月を移動し直すと読み直します)。");
    }
    return;
  }
  const before = JSON.stringify(state.entries);
  const prevStatus = { text: $("status").textContent, error: $("status").className === "error" };
  const y = window.scrollY;
  const id = state.loadId + 1;
  await load();
  if (id !== state.loadId || $("status").className === "error") return;
  window.scrollTo(0, y);
  if (JSON.stringify(state.entries) !== before) setStatus("ほかの画面で変わった内容を読み直しました。");
  else if (prevStatus.text && !prevStatus.error) setStatus(prevStatus.text); // 変わっていなければ、前のメッセージを残す(M2)
});

// ---------- 写真取込 ----------
// 取込の内容を、その月の入力に置き換える(まだ保存・登録はしない)。設計は docs/photo/DESIGN.md
async function applyImport(text) {
  if (state.registering || state.saving) {
    setStatus("登録・保存が終わってから、もう一度取り込んでください。", true);
    return;
  }
  let data;
  try {
    data = decodeImport(text);
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  const { year, month, days, who } = data;
  const unsureDays = data.unsure || [];
  const unsureNote = unsureDays.length ? "読みにくかった日: " + unsureDays.map((d) => d + "日").join("、") + "(写真と見比べてください)。" : "";
  // 番号もメモも無い取込は断る(反映すると、その月が空で置き換わるため。M4)
  if (!days.size) {
    setStatus("取り込む日がありません(番号が1つも入っていません)。写真取込でもう一度読み取ってください。", true);
    return;
  }
  const now = nowParts();
  if (year * 12 + month < now.year * 12 + now.month) {
    setStatus(year + "年" + month + "月は過ぎた月なので、取り込めません。", true);
    return;
  }
  const label = year + "年" + month + "月";
  const sameMonth = year === state.year && month === state.month;
  const lose = state.dirty ? (sameMonth ? "\n登録していない変更は消えます。" : "\n今の月の登録していない変更は消えます。") : "";
  if (!confirm(label + "に、写真取込の内容(" + days.size + "日分)を入れます。" + (who ? "\n読んだ行の名前: " + who + "(自分の名前か確かめてください)" : "") + "\nこの月の今の入力は置き換わります(まだ保存・登録はしません)。" + lose + "\nよろしいですか？")) {
    setStatus("写真取込をやめました。");
    return;
  }
  if (!sameMonth || !state.master.periods.length) {
    state.dirty = false;
    state.year = year;
    state.month = month;
    await load();
    if ($("status").className === "error" || state.year !== year || state.month !== month) {
      // その月を読み込めなかった。取込の内容は取っておき、読み直したときに使う(K5)
      stashImport(text);
      if ($("status").className === "error") setStatus($("status").textContent + "(写真取込の内容は取ってあります。画面を読み直すと、もう一度取り込めます)", true);
      return;
    }
  }

  const entries = {};
  days.forEach(({ code, memo }, d) => {
    // 一覧にある番号は(全角で読んでいても)一覧の番号に。無い番号は手入力として入る
    const key = dateKey(year, month, d);
    entries[key] = { code: masterCodeOf(code, key) || code, memo };
  });
  state.entries = entries;
  // 泊の翌日(非番)の番号は消す(「—」を読んだ「〜」など)。メモは残す(非番の日に書いた退勤時間)
  offdutyDays().forEach((_, key) => {
    if (state.entries[key]) state.entries[key].code = "";
  });
  state.imported = new Set(Object.keys(entries));
  changed();
  window.scrollTo(0, 0);
  const needTime = document.querySelectorAll("#list tr.needtime").length;
  // 一覧(マスタ)にない番号を並べる。休みの番号が一覧にないと、登録で勤務用カレンダーに入るので知らせる(L3)
  const unknown = [...new Set(Object.entries(state.entries).map(([key, e]) => [key, e.code.trim()])
    .filter(([key, c]) => c && !masterAt(key)[c] && !/^[〜~\-ー—]$/.test(c)).map(([, c]) => c))];
  const offUnknown = unknown.filter((c) => /休/.test(c) && !/[出勤]/.test(c));
  setStatus("写真取込: " + (who ? "「" + who + "」の行の" : "") + days.size + "日分を入れました。確かめて「登録」(カレンダーに入れる)か「保存」(入力だけ残す)を押してください。" + unsureNote +
    (unknown.length ? "一覧にない番号: " + unknown.join("、") + "(手入力として入りました)。" : "") +
    (needTime ? "時間の無い日が" + needTime + "日あります(黄色)。分かればメモに時間を入れてください。" : "") +
    (offUnknown.length ? "休みの番号(" + offUnknown.join("、") + ")が一覧に無いので、登録すると勤務用カレンダーに入ります。管理者に一覧への追加を頼んでください。" : ""));
}

if (PHOTO_IMPORT_URL) {
  $("photo-import").href = PHOTO_IMPORT_URL;
  $("photo-import").hidden = false;
}
$("paste-import").addEventListener("click", () => {
  $("paste-text").value = "";
  $("paste-error").hidden = true;
  $("paste-dialog").showModal();
  $("paste-text").focus();
});
$("paste-cancel").addEventListener("click", () => $("paste-dialog").close());
$("paste-run").addEventListener("click", () => {
  const text = $("paste-text").value;
  try {
    decodeImport(text); // 形が違うときは、ダイアログの中で知らせる
  } catch (err) {
    $("paste-error").textContent = err.message;
    $("paste-error").hidden = false;
    return;
  }
  $("paste-dialog").close();
  applyImport(text);
});

$("reset").addEventListener("click", () => {
  if (state.registering || state.saving) return;
  $("reset-month").value = state.year + "-" + pad(state.month);
  $("reset-dialog").showModal();
});
$("reset-cancel").addEventListener("click", () => $("reset-dialog").close());
$("reset-run").addEventListener("click", async () => {
  const m = $("reset-month").value.trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m) {
    alert("月を「2026-10」の形で選んでください。");
    return;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!confirm(year + "年" + month + "月の予定と入力内容を削除します。よろしいですか？")) return;
  $("reset-dialog").close();
  $("reset").disabled = true;
  setStatus("削除中…");
  try {
    const result = await callFunction("delete-month", { year, month }, { timeoutMs: 150000 });
    const message = year + "年" + month + "月の予定を" + result.count + "件削除し、入力内容を空にしました。";
    // 表示中の月を消したときと、前の月を消したとき(1日の非番が変わる)は、画面を読み直す。
    // 前の月のときは、表示中の月に登録していない変更があれば消さないよう読み直さない
    const prev = new Date(state.year, state.month - 2, 1);
    const isShown = year === state.year && month === state.month;
    const isPrev = year === prev.getFullYear() && month === prev.getMonth() + 1;
    if (!state.registering && (isShown || (isPrev && !state.dirty))) {
      state.dirty = false;
      await load();
      if ($("status").className === "error") return; // 読み直しの失敗を見せる
    } else if (!state.registering && isPrev) {
      // 登録していない変更は残すが、前の月の月末は空になったので、1日の非番だけ表示し直す
      // (1日が非番でなくなるので、非番のメモも自動の値に戻る。サーバーも同じように消している)
      state.prevLastCode = "";
      codeChanged();
    }
    setStatus(message);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("reset").disabled = false;
  }
});

// 区所を選んでいれば入れる(接続テストの前でも、入力を「保存」で残せるように。登録はサーバーが接続テストを確かめる。AD2)
requireLogin("input.html", { needOffice: true })
  .then((ctx) => {
    if (!ctx) return;
    state.officeId = ctx.settings.office_id;
    $("setup-note").hidden = !!ctx.settings.verified_at;
    return load().then(() => {
      // 写真取込のリンクで開いたとき(ログインし直したあとも)は、最初の読み込みのあとで取り込む。
      // 読み込みに失敗したときは取り出さずに取っておき、画面を読み直したときに使う(K5)
      if ($("status").className === "error") return;
      const pending = takePendingImport();
      if (pending) applyImport(pending);
    });
  })
  .catch((err) => setStatus(err.message || String(err), true));
