// 勤務入力画面
import { $, callFunction, requireLogin, supabase } from "./app.js";
import { addDays, dateKey, dayTypeOf, daysInMonth, describe, dutyMemo, indexMaster, offdutyMemo, pad } from "./plan.js";

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
  dirty: false,
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
  $("title").textContent = state.year + "年" + state.month + "月";
  $("prev").disabled = isFirstMonth();
  $("register").disabled = true;
  $("list").innerHTML = "";
  setStatus("読み込み中…");

  const first = dateKey(state.year, state.month, 1);
  const last = dateKey(state.year, state.month, daysInMonth(state.year, state.month));
  const prevLast = addDays(first, -1);
  const nextFirst = addDays(last, 1);
  try {
    const [masterRes, recordsRes, holidays] = await Promise.all([
      supabase.from("shift_master").select("*").eq("office_id", state.officeId).order("sort_order"),
      supabase.from("shift_records").select("date, code, memo").gte("date", prevLast).lte("date", last),
      loadHolidays(first, nextFirst),
    ]);
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
    state.dirty = false;
    render();
    scrollToToday();
    $("register").disabled = false;
    $("reset").disabled = false;
    setStatus(state.masterList.length ? "" : "この区所の勤務コードのマスタが空です。管理者に登録を頼んでください。", !state.masterList.length);
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function entryOf(key) {
  if (!state.entries[key]) state.entries[key] = { code: "", memo: "" };
  return state.entries[key];
}

function render() {
  const { year, month } = state;
  const list = $("list");
  list.innerHTML = "";

  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const key = dateKey(year, month, d);
    const e = entryOf(key);
    const dayType = dayTypeOf(key, state.holidays);
    const weekday = new Date(year, month - 1, d).getDay();

    const prevCode = d === 1 ? state.prevLastCode : (state.entries[dateKey(year, month, d - 1)] || {}).code;
    const prevMaster = state.master[prevCode];
    const offduty = prevMaster && prevMaster.type === "泊";
    if (offduty) e.code = "";

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
      const entry = state.master[e.code];
      const isManual = e.code && !entry;
      const pick = document.createElement("button");
      pick.className = "pick";
      pick.textContent = isManual ? "手入力" : e.code;
      pick.addEventListener("click", () => {
        openPicker(d + "(" + WEEKDAYS[weekday] + ")", isManual ? MANUAL : e.code, (value) => {
          e.code = value === MANUAL ? " " : value;
          e.memo = "";
          changed();
          if (value === MANUAL) list.children[d - 1].querySelector(".code input").focus();
        });
      });
      codeTd.appendChild(pick);

      if (isManual) {
        const input = document.createElement("input");
        input.value = e.code.trim();
        input.placeholder = "入力";
        input.addEventListener("input", () => {
          // 空欄でも手入力モードを保つため空白1文字を入れておく(登録時は無視される)
          e.code = input.value || " ";
          state.dirty = true;
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
      state.dirty = true;
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

function changed() {
  state.dirty = true;
  render();
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
  if (state.dirty) ev.preventDefault();
});

$("register").addEventListener("click", async () => {
  const button = $("register");
  button.disabled = true;
  setStatus("登録中…(30秒ほどかかることがあります)");
  try {
    const result = await callFunction("register-month", {
      year: state.year,
      month: state.month,
      entries: state.entries,
    });
    state.dirty = false;
    setStatus(result.count + "件の予定を登録しました。" +
      (result.skipped ? "(休日用のカレンダーを設定していないため、休日の予定" + result.skipped + "件は登録していません)" : ""));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    button.disabled = false;
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
  if (!confirm(year + "年" + month + "月の予定を削除します。よろしいですか？")) return;
  $("reset-dialog").close();
  $("reset").disabled = true;
  setStatus("削除中…");
  try {
    const result = await callFunction("delete-month", { year, month });
    setStatus(year + "年" + month + "月の予定を" + result.count + "件削除しました。");
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
