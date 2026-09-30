// 勤務入力画面
import { $, callFunction, requireLogin, supabase } from "./app.js?v=dev";
import { addDays, dateKey, dayTypeOf, daysInMonth, describe, dutyMemo, indexMaster, offdutyMemo, pad } from "./plan.js?v=dev";

const MANUAL = "__manual__";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const today = new Date();
const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
const firstMonth = { year: today.getFullYear(), month: today.getMonth() + 1 };
const state = {
  year: firstMonth.year,
  month: firstMonth.month,
  masterList: [],
  master: {},
  entries: {},       // { "yyyy-MM-dd": { code, memo } }  memo は手修正したときだけ
  prevLastCode: "",
  officeId: null,
  holidays: [],
  offduty: new Map(), // 表示中の非番の日(番号を変えたとき、非番になった・非番でなくなった日を調べるため)
  dirty: false,
  edits: 0,          // 書き換えた回数。登録中に書き換えた分を「登録済み」にしないため
  loadId: 0,         // 読み込みの番号。月を続けて移動したとき、古い月の結果で上書きしないため
  registering: false,
};

function isFirstMonth() {
  return state.year === firstMonth.year && state.month === firstMonth.month;
}

function setStatus(text, isError) {
  $("status").textContent = text;
  $("status").className = isError ? "error" : "";
}

// 祝日: キャッシュが無い年だけ Edge Function に取りに行かせる
async function loadHolidays(first, nextFirst) {
  const years = [...new Set([Number(first.slice(0, 4)), Number(nextFirst.slice(0, 4))])];
  const { data: cached, error } = await supabase.from("holiday_years").select("year").in("year", years);
  if (error) throw error;
  if ((cached || []).length < years.length) {
    const result = await callFunction("sync-holidays", { years });
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

async function loadMonth(id) {
  $("title").textContent = state.year + "年" + state.month + "月";
  $("prev").disabled = isFirstMonth();
  $("register").disabled = true;
  $("list").innerHTML = "";
  // 読み込みが終わるまでは前の月の入力が残っているので、登録で送らないよう空にしておく
  state.entries = {};

  const first = dateKey(state.year, state.month, 1);
  const last = dateKey(state.year, state.month, daysInMonth(state.year, state.month));
  const prevLast = addDays(first, -1);
  const nextFirst = addDays(last, 1);
  const [masterRes, recordsRes, holidays] = await Promise.all([
    supabase.from("shift_master").select("*").eq("office_id", state.officeId).order("sort_order"),
    supabase.from("shift_records").select("date, code, memo").gte("date", prevLast).lte("date", last),
    loadHolidays(first, nextFirst),
  ]);
  if (id !== state.loadId) return; // 読み込み中に別の月へ移動した
  if (masterRes.error) throw masterRes.error;
  if (recordsRes.error) throw recordsRes.error;

  state.masterList = masterRes.data || [];
  state.master = indexMaster(state.masterList);
  state.entries = {};
  state.prevLastCode = "";
  (recordsRes.data || []).forEach((r) => {
    if (r.date === prevLast) state.prevLastCode = r.code;
    else state.entries[r.date] = { code: r.code, memo: r.memo };
  });
  state.holidays = holidays;
  // 非番の日に番号が残っていたら(前の月の月末を泊にしたときの1日など)、番号とメモを消す。
  // 登録でもサーバーが消す。残しておくと、非番のメモに前の番号のメモが出てしまうため
  offdutyDays().forEach((_, key) => {
    const e = state.entries[key];
    if (e && (e.code || "").trim()) state.entries[key] = { code: "", memo: "" };
  });
  state.dirty = false;
  render();
  scrollToToday();
  $("register").disabled = false;
  $("reset").disabled = false;
  setStatus(state.masterList.length ? "" : "この区所の勤務コードのマスタが空です。管理者に登録を頼んでください。", !state.masterList.length);
}

function entryOf(key) {
  if (!state.entries[key]) state.entries[key] = { code: "", memo: "" };
  return state.entries[key];
}

// 非番の日 → 前日の泊のマスタ。前日の番号で決める(非番の日は番号なし扱い。サーバーの buildPlan と同じ判定)。
// 非番の日の番号は無視する(登録時もサーバーが無視する)。番号を変えて非番になった日の番号は codeChanged で消す
function offdutyDays() {
  const days = new Map();
  let prevCode = state.prevLastCode;
  for (let d = 1; d <= daysInMonth(state.year, state.month); d++) {
    const key = dateKey(state.year, state.month, d);
    const prevMaster = state.master[prevCode];
    const offduty = !!(prevMaster && prevMaster.type === "泊");
    if (offduty) days.set(key, prevMaster);
    prevCode = offduty ? "" : ((state.entries[key] || {}).code || "").trim();
  }
  return days;
}

function render() {
  const { year, month } = state;
  const list = $("list");
  list.innerHTML = "";
  state.offduty = offdutyDays();

  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const key = dateKey(year, month, d);
    const e = entryOf(key);
    const dayType = dayTypeOf(key, state.holidays);
    const weekday = new Date(year, month - 1, d).getDay();

    const prevMaster = state.offduty.get(key);
    const offduty = !!prevMaster;

    const tr = document.createElement("tr");
    if (key === todayKey) tr.className = "today";

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
      autoMemo = offdutyMemo(prevMaster, dayType);
    } else {
      // 番号は前後の空白を除いて見る(登録時もサーバーが除く)
      const code = e.code.trim();
      const entry = state.master[code];
      const isManual = !!e.code && !entry;
      const pick = document.createElement("button");
      pick.className = "pick";
      pick.textContent = isManual ? "手入力" : code;
      pick.addEventListener("click", () => {
        openPicker(d + "(" + WEEKDAYS[weekday] + ")", isManual ? MANUAL : code, (value) => {
          e.code = value === MANUAL ? " " : value;
          e.memo = "";
          codeChanged();
          if (value === MANUAL) list.children[d - 1].querySelector(".code input").focus();
        });
      });
      codeTd.appendChild(pick);

      if (isManual) {
        const input = document.createElement("input");
        input.value = code;
        input.placeholder = "入力";
        input.addEventListener("input", () => {
          // 空欄でも手入力モードを保つため空白1文字を入れておく(登録時は無視される)
          e.code = input.value || " ";
          edited();
        });
        // 入れ終えたとき、一覧にある番号なら、その番号として表示し直す
        // (登録ではサーバーが一覧の番号として扱う。泊なら翌日が非番になる)
        input.addEventListener("change", () => {
          const value = input.value.trim();
          if (!state.master[value]) return;
          e.code = value;
          codeChanged();
        });
        codeTd.appendChild(input);
      } else if (entry) {
        autoMemo = dutyMemo(entry, dayType);
        // 泊地はメモの2行目としてカレンダーに入る(画面ではメモ欄の下に表示)
        stay = describe(entry, "");
      }
    }

    // メモ: 番号を選ぶと自動で入る。手で書き換えも可
    const memoTd = document.createElement("td");
    memoTd.className = "memo";
    const memoInput = document.createElement("input");
    memoInput.value = e.memo || autoMemo;
    memoInput.placeholder = autoMemo;
    if (e.memo) memoInput.className = "override";
    memoInput.addEventListener("input", () => {
      const value = memoInput.value.trim();
      e.memo = value === autoMemo ? "" : value;
      memoInput.className = e.memo ? "override" : "";
      edited();
    });
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

function edited() {
  state.dirty = true;
  state.edits++;
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

function openPicker(title, current, callback) {
  onPick = callback;
  $("picker-title").textContent = title;
  [["picker-duty", (m) => m.kind !== "休日"], ["picker-off", (m) => m.kind === "休日"]].forEach(([id, match]) => {
    const grid = $(id);
    grid.innerHTML = "";
    state.masterList.filter(match).forEach((m) => {
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
  if (state.registering) return;
  if (delta < 0 && isFirstMonth()) return;
  if (state.dirty && !confirm("登録していない変更があります。移動しますか？")) return;
  const date = new Date(state.year, state.month - 1 + delta, 1);
  state.year = date.getFullYear();
  state.month = date.getMonth() + 1;
  load();
}

$("prev").addEventListener("click", () => moveMonth(-1));
$("next").addEventListener("click", () => moveMonth(1));

window.addEventListener("beforeunload", (ev) => {
  if (!state.dirty) return;
  ev.preventDefault();
  ev.returnValue = ""; // 古いブラウザは returnValue が無いと確認を出さない
});

// iPhone の Safari(ホーム画面に追加したアプリも)は、ページを離れるときの確認(beforeunload)を出さない。
// 上のナビ(設定・使い方・ログアウトなど)で移るときも、ここで確かめる
document.addEventListener("click", (ev) => {
  const link = ev.target.closest && ev.target.closest("a[href]");
  if (!link || !state.dirty) return;
  if (confirm("登録していない変更があります。移動しますか？")) {
    state.dirty = false; // 移ると決めたので、beforeunload でもう一度聞かない
    return;
  }
  ev.preventDefault();
  ev.stopPropagation(); // ログアウトのリンクの処理も止める
}, true);

$("register").addEventListener("click", async () => {
  const button = $("register");
  button.disabled = true;
  // 登録中は月を移動できないようにする(移動先の月の入力と混ざらないように)
  state.registering = true;
  $("prev").disabled = true;
  $("next").disabled = true;
  setStatus("登録中…(30秒ほどかかることがあります)");
  const edits = state.edits;
  try {
    const result = await callFunction("register-month", {
      year: state.year,
      month: state.month,
      entries: state.entries,
    });
    // 登録中に書き換えた分は送っていないので、未登録のままにする(月の移動などで確認が出るように)
    const editedMeanwhile = state.edits !== edits;
    if (!editedMeanwhile) state.dirty = false;
    setStatus(result.count + "件の予定を登録しました。" +
      (result.skipped ? "(休日用のカレンダーを設定していないため、休日の予定" + result.skipped + "件は登録していません)" : "") +
      (editedMeanwhile ? "登録中に変えたところは、まだ登録していません。もう一度「登録」を押してください。" : ""));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    state.registering = false;
    button.disabled = false;
    $("prev").disabled = isFirstMonth();
    $("next").disabled = false;
  }
});

$("reset").addEventListener("click", () => {
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
    const result = await callFunction("delete-month", { year, month });
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
    }
    setStatus(message);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("reset").disabled = false;
  }
});

requireLogin("input.html", { needVerified: true })
  .then((ctx) => {
    if (!ctx) return;
    state.officeId = ctx.settings.office_id;
    load();
  })
  .catch((err) => setStatus(err.message || String(err), true));
