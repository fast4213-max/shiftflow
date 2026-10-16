// 管理画面(ダッシュボード)。管理者だけ。管理用パスワードでログインしたセッションで動く。
import { friendlyText, $, callFunction, copyText, formatDateTime, requireLogin, selectAllPages, sharedPasswordProblem, supabase } from "./app.js?v=dev";
import { SUPABASE_ANON_KEY, SUPABASE_URL, TOKEN_EXPIRES } from "./config.js?v=dev";
import { checkMasterRows, masterRowsFromCsv, masterToCsv, readTextFile } from "./csv.js?v=dev";
import { initContactAdmin } from "./admin-contact.js?v=dev";
import { initNoticesAdmin } from "./admin-notices.js?v=dev";
import { initGuideAdmin } from "./admin-guide.js?v=dev";
import { addDays, periodLabel, shortDate } from "./plan.js?v=dev";

const MASTER_COLUMNS = [
  ["code", "番号"],
  ["kind", "種別"],
  ["weekday_start", "平日出勤"],
  ["weekday_end", "平日退勤"],
  ["holiday_start", "休日出勤"],
  ["holiday_end", "休日退勤"],
  ["stay", "泊"],
  ["weekday_holiday_start", "平休出勤"],
  ["weekday_holiday_end", "平休退勤"],
  ["holiday_weekday_start", "休平出勤"],
  ["holiday_weekday_end", "休平退勤"],
  ["stay_next_holiday", "翌休泊"],
];

// 区所の名前の長さの上限(お問い合わせの「所属」に写すときの上限と同じ。Q9)
const OFFICE_NAME_MAX = 60;

let stats = null;
// マスタのタブ: 選んでいる区所の、全部の切替日のマスタの行(読み込み中・失敗のときは null。S4)
let masterRows = null;
let masterRowsOfficeId = null;
let selectedPeriodId = null; // 選んでいる切替日の id。"new" は「次のマスタ」を作るところ
let pendingRows = null;
let pendingTarget = null; // 確認中の CSV を入れる先 { officeId, periodId }(ほかの区所・切替日に移ったら確認を消す。AB1)
let nameTouched = false; // 「次のマスタ」で名前を手で選んだか(選んだあとは、切替日を変えても名前を変えない)

function message(text, kind) {
  $("message").textContent = friendlyText(text) || "";
  $("message").className = "message" + (kind ? " " + kind : "");
}

function cell(tr, content, className) {
  const td = document.createElement("td");
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = content == null ? "" : content;
  if (className) td.className = className;
  tr.appendChild(td);
  return td;
}

function button(label, onClick, className) {
  const b = document.createElement("button");
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

function fullName(u) {
  return `${u.family_name} ${u.given_name}`;
}

// ---------- タブ ----------

function showTab(name, { keepMessage = false } = {}) {
  document.querySelectorAll(".dtab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("hidden", p.id !== "pane-" + name));
  if (!keepMessage) message("");
  history.replaceState(null, "", "#" + name);
}
document.querySelectorAll(".dtab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

// ---------- 概要 ----------

// アクセストークンの期限までの日数(期限の日の終わりまで使える)
// 期限が過ぎたら負の数(期限の翌日の途中でも -1。以前は 0 になり「あと0日」と出ていた。S17)
function tokenDaysLeft() {
  const ms = new Date(TOKEN_EXPIRES + "T23:59:59+09:00") - new Date();
  return ms < 0 ? Math.floor(ms / 86400000) : Math.ceil(ms / 86400000);
}

function tokenLabel() {
  const [y, m, d] = TOKEN_EXPIRES.split("-").map(Number);
  const left = tokenDaysLeft();
  const date = `${y}年${m}月${d}日`;
  if (left < 0) return `${date}(期限が切れています。新しいトークンを作ってください)`;
  return `${date}(あと${left}日)`;
}

// onAction: ボタンを押したときに、タブを開く前にすること(マスタの区所・切替日を選ぶなど)
function alertBox(kind, text, actionLabel, tab, onAction) {
  const div = document.createElement("div");
  div.className = "alert " + kind;
  const span = document.createElement("span");
  span.textContent = text;
  div.appendChild(span);
  if (actionLabel) {
    div.appendChild(button(actionLabel, () => {
      if (onAction) onAction();
      showTab(tab);
    }));
  }
  return div;
}

// マスタのタブで、区所と切替日を選んで開く
function openPeriod(officeId, periodId) {
  clearPreview();
  $("master-office").value = String(officeId);
  selectedPeriodId = periodId;
  loadMaster().catch((err) => message(err.message, "error"));
}

function renderOverview() {
  $("kpi-users").textContent = stats.users;
  $("kpi-verified").textContent = stats.verified;
  $("kpi-verified-sub").textContent = stats.users ? `全体の ${Math.round((stats.verified / stats.users) * 100)}%` : "";
  $("kpi-active").textContent = stats.active_30d;
  $("kpi-new").textContent = stats.signups_7d;

  const alerts = $("alerts");
  alerts.innerHTML = "";
  if (tokenDaysLeft() <= 30) {
    alerts.appendChild(alertBox("warn", "Supabase のアクセストークンの期限が近づいています: " + tokenLabel(), "設定へ", "settings"));
  }
  if (!stats.signup_password_set) {
    alerts.appendChild(alertBox("warn", "新規登録の共通パスワードが未設定です。設定するまで、新しい人は登録できません。", "設定へ", "settings"));
  }
  if (stats.offices.length === 0) {
    alerts.appendChild(alertBox("warn", "区所がまだありません。区所を追加して、マスタを取り込んでください。", "マスタへ", "master"));
  } else {
    const empty = stats.offices.filter((o) => o.master_count === 0);
    if (empty.length) {
      alerts.appendChild(alertBox("warn", "マスタが空の区所があります: " + empty.map((o) => o.name).join("、"), "マスタへ", "master"));
    }
    // これからの切替(ダイヤ改正・ダイヤ修正): CSV が未登録なら注意、2週間以内なら知らせる
    stats.offices.forEach((o) => {
      periodsOf(o).filter((p) => p.from > stats.today).forEach((p) => {
        const days = daysBetween(stats.today, p.from);
        const what = `${o.name}: 「${periodLabel(p)}」(${shortDate(p.from)}〜、あと${days}日)`;
        if (!p.count) {
          alerts.appendChild(alertBox("warn", what + "のマスタ(CSV)がまだありません。入れるまで、切替日から後の日と前の日の泊は登録できません。",
            "マスタへ", "master", () => openPeriod(o.id, p.id)));
        } else if (days <= 14) {
          alerts.appendChild(alertBox("info", what + "に切り替わります。", "マスタへ", "master", () => openPeriod(o.id, p.id)));
        }
      });
    });
  }
  if (stats.no_office > 0) {
    alerts.appendChild(alertBox("info", `区所をまだ選んでいない人が ${stats.no_office}人 います(設定画面で選んでもらいます)。`));
  }

  const bars = $("office-bars");
  bars.innerHTML = "";
  if (stats.offices.length === 0) {
    bars.textContent = "区所がありません。";
  } else {
    const max = Math.max(1, ...stats.offices.map((o) => o.user_count));
    stats.offices.forEach((o) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      const name = document.createElement("div");
      name.className = "bar-name";
      name.textContent = o.name;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = (o.user_count / max) * 100 + "%";
      track.appendChild(fill);
      const count = document.createElement("div");
      count.className = "bar-count";
      count.textContent = o.user_count + "人";
      row.append(name, track, count);
      bars.appendChild(row);
    });
  }

  const recent = $("recent");
  recent.innerHTML = "";
  stats.users_list.slice(0, 5).forEach((u) => {
    const tr = document.createElement("tr");
    cell(tr, u.employee_no, "mono");
    cell(tr, fullName(u));
    cell(tr, u.office || "—");
    cell(tr, formatDateTime(u.created_at));
    recent.appendChild(tr);
  });
  if (stats.users_list.length === 0) {
    const tr = document.createElement("tr");
    cell(tr, "まだ登録した人がいません。").colSpan = 4;
    recent.appendChild(tr);
  }
}

// ---------- 利用者 ----------

async function resetPin(u) {
  if (!confirm(`${fullName(u)}(${u.employee_no})に仮のPINを発行します。今のPINは使えなくなります。よろしいですか？`)) return;
  try {
    const result = await callFunction("admin-users", { action: "reset-pin", user_id: u.user_id });
    $("pin-who").textContent = `${fullName(u)}(社員番号 ${u.employee_no})`;
    $("pin-value").textContent = result.pin;
    // その人がログインしていた端末は、ログアウトさせた(スマホを落としたときなども、その端末から使えなくなる)
    $("pin-sessions").textContent = result.sessionsCleared === true ? "この人がログインしていた端末は、すべてログアウトしました。"
      : result.sessionsCleared === false ? "この人がログインしていた端末のログインは、消せませんでした(その端末からは、まだ使えます)。" : "";
    $("pin-sessions").className = result.sessionsCleared === false ? "message error" : "muted";
    $("pin-dialog").showModal();
  } catch (err) {
    message(err.message, "error");
  }
}

async function deleteUser(u) {
  if (!confirm(`${fullName(u)}(${u.employee_no})を削除します。\nこの人の設定と勤務の記録も消え、ログインできなくなります(カレンダーに登録済みの予定は残ります)。よろしいですか？`)) return;
  try {
    await callFunction("admin-users", { action: "delete", user_id: u.user_id });
    message(`${fullName(u)} を削除しました。`, "ok");
    refresh();
  } catch (err) {
    message(err.message, "error");
  }
}

// 利用者の並べ替え(画面だけ。DB は触らない)。key が null のときは読み込んだ順(登録の新しい順)。
// 日付・数・接続は多い順・新しい順から始め、空(未ログイン・未登録・区所なし)はどちら向きでも一番下
const userSort = { key: null, dir: 1 };
const DESC_FIRST = ["verified", "last_sign_in_at", "last_registered_at", "record_days"];

function sortedUsers(list) {
  const { key, dir } = userSort;
  if (!key) return list;
  const value = (u) => (key === "verified" ? (u.verified ? 1 : 0) : u[key]);
  const empty = (v) => v === null || v === undefined || v === "";
  return list
    .map((u, i) => ({ u, i, v: value(u) }))
    .sort((a, b) => {
      if (empty(a.v) !== empty(b.v)) return empty(a.v) ? 1 : -1;
      if (empty(a.v)) return a.i - b.i;
      const c = typeof a.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v), "ja", { numeric: true });
      return c ? c * dir : a.i - b.i;
    })
    .map((x) => x.u);
}

function updateSortHeads() {
  document.querySelectorAll("#users-head th").forEach((th) => {
    const btn = th.querySelector(".sort-btn");
    if (!btn) return;
    const on = btn.dataset.sort === userSort.key;
    th.setAttribute("aria-sort", on ? (userSort.dir === 1 ? "ascending" : "descending") : "none");
    btn.dataset.mark = on ? (userSort.dir === 1 ? "▲" : "▼") : "";
  });
}

$("users-head").addEventListener("click", (e) => {
  const btn = e.target.closest(".sort-btn");
  if (!btn) return;
  const key = btn.dataset.sort;
  if (userSort.key === key) userSort.dir = -userSort.dir;
  else {
    userSort.key = key;
    userSort.dir = DESC_FIRST.includes(key) ? -1 : 1;
  }
  if (stats) renderUsers();
});

function renderUsers() {
  const query = $("user-search").value.trim().toLowerCase().replace(/\s+/g, "");
  const list = sortedUsers(stats.users_list.filter((u) =>
    !query || (u.employee_no + fullName(u)).toLowerCase().replace(/\s+/g, "").includes(query)
  ));
  updateSortHeads();
  $("users-count").textContent = `${list.length}人`;
  const tbody = $("users");
  tbody.innerHTML = "";
  list.forEach((u) => {
    const tr = document.createElement("tr");
    cell(tr, u.employee_no, "mono");
    cell(tr, fullName(u));
    cell(tr, u.office || "—");
    cell(tr, u.verified ? "済" : "—");
    cell(tr, u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : "未ログイン");
    cell(tr, formatDateTime(u.last_registered_at));
    cell(tr, u.record_days + "日");
    const actions = document.createElement("div");
    actions.append(button("PIN再設定", () => resetPin(u)), button("削除", () => deleteUser(u)));
    cell(tr, actions);
    tbody.appendChild(tr);
  });
  if (list.length === 0) {
    const tr = document.createElement("tr");
    cell(tr, "該当する人がいません。").colSpan = 8;
    tbody.appendChild(tr);
  }
}
$("user-search").addEventListener("input", () => stats && renderUsers());
$("pin-close").addEventListener("click", () => $("pin-dialog").close());
// Esc で閉じたときも、仮のPINを画面に残さない(AD12)
$("pin-dialog").addEventListener("close", () => {
  $("pin-value").textContent = "";
});

// ---------- 区所 ----------

function fillOfficeSelects() {
  const select = $("master-office");
  const keep = select.value;
  select.innerHTML = "";
  stats.offices.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.name;
    select.appendChild(opt);
  });
  if (stats.offices.some((o) => String(o.id) === keep)) select.value = keep;
  // 区所が消されて別の区所に変わったら、確認中の CSV は取り消す(別の区所のマスタを入れ替えないように)
  if (select.value !== keep) {
    clearPreview();
    selectedPeriodId = null;
  }
}

// 区所を1つ上(-1)・下(+1)へ動かす。並びは sort_order で決まり、利用者の設定画面・お問い合わせの区所の一覧も同じ並びになる。
// 抜け(削除したあと)や同じ数字があっても崩れないよう、動かすたびに全部を 1,2,3… に振り直す
let movingOffice = false;
async function moveOffice(index, delta) {
  if (movingOffice) return; // 連打で、古い並びから計算した2回目が1回目を上書きしないように
  const list = stats.offices.slice();
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  movingOffice = true;
  document.querySelectorAll("#offices button").forEach((b) => { b.disabled = true; });
  try {
    // 1つずつ順に送る(同時に送って一部だけ失敗すると、並びが重複・抜けになる)。失敗したら止めて、読み直す
    for (let i = 0; i < list.length; i++) {
      const { error } = await supabase.from("offices").update({ sort_order: i + 1 }).eq("id", list[i].id);
      if (error) { message(error.message, "error"); break; }
    }
  } finally {
    movingOffice = false;
    await refresh();
  }
}

function renderOffices() {
  const tbody = $("offices");
  tbody.innerHTML = "";
  stats.offices.forEach((o, index) => {
    const tr = document.createElement("tr");
    cell(tr, o.name);
    const now = periodsOf(o).find((p) => p.id === periodIdOn(o, stats.today));
    cell(tr, (now ? periodLabel(now) + " " : "") + o.master_count + "件");
    cell(tr, o.user_count + "人");
    const actions = document.createElement("div");
    const up = button("↑", () => moveOffice(index, -1));
    const down = button("↓", () => moveOffice(index, 1));
    up.disabled = index === 0;
    down.disabled = index === stats.offices.length - 1;
    up.title = "1つ上へ";
    down.title = "1つ下へ";
    actions.append(
      up,
      down,
      button("名前変更", async () => {
        const name = prompt("新しい名前(60文字まで)", o.name);
        if (!name || !name.trim() || name.trim() === o.name) return;
        if ([...name.trim()].length > OFFICE_NAME_MAX) return message(`区所の名前は${OFFICE_NAME_MAX}文字までにしてください。`, "error");
        const { error } = await supabase.from("offices").update({ name: name.trim() }).eq("id", o.id);
        if (error) return message(error.code === "23505" ? "同じ名前の区所があります。" : error.message, "error");
        refresh();
      }),
      button("削除", async () => {
        const rows = periodsOf(o).reduce((n, p) => n + (p.count || 0), 0);
        const warn = `${o.name} を削除しますか？\nこの区所の全部の切替日のマスタ(${rows}件)も消え、選んでいる利用者(${o.user_count}人)は区所を選び直すまで登録できなくなります。`;
        if (!confirm(warn)) return;
        const { error } = await supabase.from("offices").delete().eq("id", o.id);
        if (error) return message(error.message, "error");
        refresh();
      }),
    );
    cell(tr, actions);
    tbody.appendChild(tr);
  });
  if (stats.offices.length === 0) {
    const tr = document.createElement("tr");
    cell(tr, "区所がまだありません。下で追加してください。").colSpan = 4;
    tbody.appendChild(tr);
  }
}

// 送っている間はボタンを押せなくする(2回押すと2回目が「同じ名前」の失敗になり、足せたのに失敗と出るため。AD11)
async function whileBusy(id, fn) {
  const b = $(id);
  if (b.disabled) return;
  b.disabled = true;
  try {
    await fn();
  } finally {
    b.disabled = false;
  }
}

$("add-office").addEventListener("click", () => whileBusy("add-office", async () => {
  const name = $("new-office").value.trim();
  if (!name) return;
  if ([...name].length > OFFICE_NAME_MAX) return message(`区所の名前は${OFFICE_NAME_MAX}文字までにしてください。`, "error");
  // 並びの番号は「今の最大 + 1」にする(区所を消したあとに足しても、いちばん下に入る。R8)
  const top = await supabase.from("offices").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  if (top.error) return message(top.error.message, "error");
  const { error } = await supabase.from("offices").insert({ name, sort_order: (top.data[0]?.sort_order ?? 0) + 1 });
  if (error) return message(error.code === "23505" ? "同じ名前の区所があります。" : error.message, "error");
  $("new-office").value = "";
  await refresh();
  const added = stats.offices.find((o) => o.name === name);
  if (added) openPeriod(added.id, null);
  message("区所を追加しました。上の「マスタ」で、この区所のマスタの CSV を取り込んでください(切替日と名前も入れられます)。", "ok");
}));

// ---------- マスタ(ダイヤ改正・ダイヤ修正ごと) ----------

// 区所の切替日の一覧(古い順)。from = 切替日、to = 次の切替日の前日(次が無ければ "")
function periodsOf(office) {
  const list = (office.periods || []).map((p) => ({ id: p.id, from: p.starts_on, name: p.name || "", count: p.count }));
  list.forEach((p, i) => (p.to = list[i + 1] ? addDays(list[i + 1].from, -1) : ""));
  return list;
}

// その日に使う切替日の id(その日以前に始まったうちの最新。無ければいちばん古いもの)
function periodIdOn(office, key) {
  const list = periodsOf(office);
  let found = list[0];
  for (const p of list) if (p.from <= key) found = p;
  return found ? found.id : null;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
}

function selectedOffice() {
  return stats.offices.find((o) => String(o.id) === $("master-office").value);
}

// 選んでいる切替日({ id, from, to, name, count, index })。「次のマスタを作る」なら null
function selectedPeriod() {
  const office = selectedOffice();
  if (!office || selectedPeriodId === "new") return null;
  const list = periodsOf(office);
  const i = list.findIndex((p) => p.id === selectedPeriodId);
  return i === -1 ? null : { ...list[i], index: i };
}

function rangeText(p) {
  return shortDate(p.from) + "〜" + (p.to ? shortDate(p.to) : "");
}

// 切替日のタブ(名前・期間・使用中・CSV 未登録)
function renderPeriodTabs(office) {
  const tabs = $("period-tabs");
  tabs.innerHTML = "";
  if (!office) return;
  const nowId = periodIdOn(office, stats.today);
  periodsOf(office).forEach((p) => {
    const b = document.createElement("button");
    b.className = "chip" + (p.id === selectedPeriodId ? " active" : "");
    b.setAttribute("role", "tab");
    b.append(periodLabel(p));
    const badge = document.createElement("span");
    if (!p.count) {
      badge.className = "badge warn";
      badge.textContent = "⚠CSV未登録";
    } else if (p.id === nowId) {
      badge.className = "badge";
      badge.textContent = "使用中";
    } else if (p.from > stats.today) {
      badge.className = "badge";
      badge.textContent = "あと" + daysBetween(stats.today, p.from) + "日";
    }
    if (badge.textContent) b.appendChild(badge);
    const small = document.createElement("small");
    small.textContent = rangeText(p);
    b.appendChild(small);
    b.addEventListener("click", () => selectPeriod(p.id));
    tabs.appendChild(b);
  });
  const add = document.createElement("button");
  add.className = "chip add" + (selectedPeriodId === "new" ? " active" : "");
  add.textContent = "＋ 次のマスタ";
  add.title = "次のダイヤ改正・ダイヤ修正のマスタを作る";
  add.addEventListener("click", () => selectPeriod("new"));
  tabs.appendChild(add);
}

function selectPeriod(id) {
  if (pendingRows && id !== selectedPeriodId) clearPreview();
  selectedPeriodId = id;
  $("period-message").textContent = "";
  $("csv-message").textContent = "";
  renderMasterPane();
}

// 切替日の月から名前を選ぶ(3月 → ダイヤ改正、10月 → ダイヤ修正)。ほかの月はそのまま
function guessName(key) {
  const m = Number(key.slice(5, 7));
  return m === 3 ? "ダイヤ改正" : m === 10 ? "ダイヤ修正" : null;
}

function setPeriodName(value) {
  const select = $("period-name");
  if (![...select.options].some((o) => o.value === value)) {
    // 選択肢に無い名前(SQL で入れたなど)も消さずに出す
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
  select.value = value;
}

// 選んでいる切替日の中身(切替日・名前・CSV・マスタ表)を出す
function renderMasterPane() {
  const office = selectedOffice();
  // 確認中の CSV は、入れる先(区所・切替日)が今の選択と同じときだけ残す
  if (pendingRows && (!office || !pendingTarget || pendingTarget.officeId !== office.id || pendingTarget.periodId !== selectedPeriodId)) clearPreview();
  renderPeriodTabs(office);
  $("period-body").hidden = !office;
  if (!office) return;
  const p = selectedPeriod();
  const isNew = selectedPeriodId === "new";
  const list = periodsOf(office);
  const isBase = !!p && p.index === 0;
  const started = !!p && p.from <= stats.today;

  // 選べる切替日: 今月の1日から後、かつ、いちばん古いマスタの切替日より後(サーバーと同じ。いちばん古いマスタは決まりなし)
  const firstOfMonth = stats.today.slice(0, 8) + "01";
  const minDate = list.length && addDays(list[0].from, 1) > firstOfMonth ? addDays(list[0].from, 1) : firstOfMonth;
  if (isNew) {
    $("period-summary").textContent = "次のマスタを作る";
    $("period-date").value = "";
    $("period-date").min = minDate;
    nameTouched = false;
    setPeriodName("ダイヤ改正");
    $("period-help").textContent = "切替日(新しいダイヤの初日)と名前を入れて「作る」を押してから、CSV を取り込みます。日付だけ先に作って、CSV はあとから入れてもかまいません。" +
      (stats.offices.length > 1 ? "ダイヤ改正・ダイヤ修正の日はどの区所も同じなので、ふつうは「全部の区所に同じ切替日で作る」のままにします(CSV は区所ごと)。" : "");
  } else if (p) {
    $("period-summary").textContent = periodLabel(p) + "(" + rangeText(p) + ")" +
      (p.id === periodIdOn(office, stats.today) ? " … 今使っているマスタ" : p.from > stats.today ? " … これから使うマスタ" : " … 前のマスタ");
    $("period-date").value = p.from;
    $("period-date").min = isBase ? "" : minDate;
    setPeriodName(p.name);
    $("period-help").textContent = isBase
      ? "いちばん古いマスタは、切替日より前の日にも使います(切替日は、名前と一緒に表示するためのものです)。"
      : started
        ? "もう始まっているマスタです。切替日を変えると、その前後の日の時間が変わります。"
        : "切替日から、このマスタで登録されます。切替日の前日の泊は、非番の退勤時間だけこのマスタから入ります(同じ番号の泊が無いと、その人は非番のメモに退勤時間を入れる必要があります)。";
  }
  $("period-delete").hidden = isNew || !p || isBase || started;
  // 全部の区所にまとめて(ダイヤ改正・ダイヤ修正の日はどの区所も同じ)。作るときは全部の区所、
  // 直す・消すときは、同じ切替日のマスタがあるほかの区所。いちばん古いマスタ(区所ごとに日が違う)には出さない
  const others = p ? sameDateOffices(office, p.from).length : stats.offices.length - 1;
  $("period-all-label").hidden = isBase || !p && !isNew || others === 0;
  $("period-all").checked = true;
  $("period-all-text").textContent = isNew
    ? `全部の区所(${stats.offices.length})に同じ切替日で作る`
    : `同じ切替日のほかの区所(${others})もまとめて直す・消す`;
  $("period-csv").hidden = isNew;
  $("period-save").textContent = isNew ? "作る" : "切替日を保存";
  $("copy-prev").hidden = isNew || !p || isBase;
  if (isNew || !p) return;

  if (masterRows === null || masterRowsOfficeId !== office.id) {
    renderMasterTable($("master"), [], false);
    $("master-count").textContent = "読み込み中…";
    $("master-diff").textContent = "";
    return;
  }
  const rows = masterRows.filter((r) => r.period_id === p.id);
  const prev = p.index > 0 ? list[p.index - 1] : null;
  const prevRows = prev ? masterRows.filter((r) => r.period_id === prev.id) : null;
  renderMasterTable($("master"), rows, false, prevRows);
  const counts = {};
  rows.forEach((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1));
  $("master-count").textContent = `${rows.length}件` +
    (rows.length ? "(" + Object.entries(counts).map(([k, n]) => `${k} ${n}`).join("、") + ")" : "(まだ CSV がありません)");
  // 前のマスタが空(CSV 未登録)なら比べない(全部が「増えた」になるため)
  $("master-diff").textContent = prevRows && prevRows.length && rows.length ? diffText(prev, prevRows, rows) : "";
  $("csv-download").disabled = !rows.length;
  $("copy-prev").disabled = !prevRows || !prevRows.length;
}

// 前のマスタとの違い(増えた・変わった・消えた番号)
function diffText(prev, prevRows, rows) {
  const before = new Map(prevRows.map((r) => [r.code, r]));
  const now = new Set(rows.map((r) => r.code));
  let added = 0;
  let changed = 0;
  rows.forEach((r) => {
    const b = before.get(r.code);
    if (!b) added++;
    else if (rowChanged(b, r)) changed++;
  });
  const removed = prevRows.filter((r) => !now.has(r.code)).map((r) => r.code);
  if (!added && !changed && !removed.length) return `前のマスタ(${periodLabel(prev)})と同じです。`;
  return `前のマスタ(${periodLabel(prev)})と比べて: 増えた ${added}(緑)・変わった ${changed}(黄)・無くなった ${removed.length}` +
    (removed.length ? "(" + removed.join("、") + ")" : "");
}

function rowChanged(a, b) {
  return MASTER_COLUMNS.some(([key]) => (a[key] || "") !== (b[key] || ""));
}

// prevRows があれば、前のマスタと比べて増えた行(added)・変わった行(changed)に色を付ける
function renderMasterTable(tbody, rows, withErrors, prevRows) {
  const table = tbody.closest("table");
  const head = document.createElement("tr");
  // 問題の列は、スマホでも見えるよう番号の前に置く
  ["#"].concat(withErrors ? ["問題"] : []).concat(MASTER_COLUMNS.map((c) => c[1])).forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  });
  table.tHead.innerHTML = "";
  table.tHead.appendChild(head);

  const before = prevRows ? new Map(prevRows.map((r) => [r.code, r])) : null;
  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (withErrors && r.errors.length) tr.className = "bad";
    else if (before && before.size) {
      const b = before.get(r.code);
      if (!b) tr.className = "added";
      else if (rowChanged(b, r)) tr.className = "changed";
    }
    cell(tr, i + 1, "num");
    if (withErrors) cell(tr, r.errors.length ? r.errors.join(" / ") : "OK", r.errors.length ? "err" : "ok");
    MASTER_COLUMNS.forEach(([key]) => cell(tr, r[key]));
    tbody.appendChild(tr);
  });
}

// 選んでいる区所の、全部の切替日のマスタの行を読む
async function loadMaster() {
  const office = selectedOffice();
  // 読み終わるまでは、前の区所のマスタを「今の区所のもの」として保存させない(S4)
  masterRows = null;
  masterRowsOfficeId = null;
  if (office) {
    const ids = periodsOf(office).map((p) => p.id);
    if (selectedPeriodId !== "new" && !ids.includes(selectedPeriodId)) selectedPeriodId = periodIdOn(office, stats.today);
  }
  renderMasterPane();
  if (!office) return;
  const data = await selectAllPages((from, to) =>
    supabase.from("shift_master").select("*").eq("office_id", office.id).order("period_id").order("sort_order").order("code").range(from, to)
  );
  if (String(office.id) !== $("master-office").value) return; // 読んでいる間に、別の区所に切り替えた
  masterRows = data;
  masterRowsOfficeId = office.id;
  renderMasterPane();
}
$("master-office").addEventListener("change", () => {
  clearPreview();
  selectedPeriodId = null;
  $("period-message").textContent = "";
  $("csv-message").textContent = "";
  loadMaster().catch((err) => message(err.message, "error"));
});

// 次のマスタを作るときだけ、切替日の月から名前を選ぶ(名前を手で選んだあとと、今あるマスタの切替日を直すときは変えない)
$("period-date").addEventListener("change", () => {
  if (selectedPeriodId !== "new" || nameTouched) return;
  const name = guessName($("period-date").value || "");
  if (name) setPeriodName(name);
});
$("period-name").addEventListener("change", () => { nameTouched = true; });

function periodMessage(text, kind) {
  $("period-message").textContent = friendlyText(text) || "";
  $("period-message").className = "message" + (kind ? " " + kind : "");
}

// from の前日から後の日に、勤務をもう入れている人の人数(officeId が null なら全部の区所。数えられなければ 0)
async function affectedCount(officeId, from) {
  const { data, error } = await supabase.rpc("master_affected_users", { p_office_id: officeId, p_from: from });
  return error ? 0 : data || 0;
}

// 登録し直しが要る人がいれば、そのことを添える(AB12。切替日を動かしたときは、前と後の早いほうの日から数える)
async function affectedNote(officeId, from) {
  const n = await affectedCount(officeId, from);
  if (!n) return "";
  return `${shortDate(from)}の前日から後の勤務を、もう保存・登録している人が ${n}人 います。その人は、その月をもう一度「登録」すると今のマスタの時間になります(お知らせで知らせると確実です)。`;
}

// 同じ切替日のマスタがある、ほかの区所
function sameDateOffices(office, from) {
  return stats.offices.filter((o) => o.id !== office.id && periodsOf(o).some((p) => p.from === from));
}

const allChecked = () => !$("period-all-label").hidden && $("period-all").checked;

$("period-save").addEventListener("click", async () => {
  const office = selectedOffice();
  if (!office) return;
  const date = $("period-date").value;
  if (!date) return periodMessage("切替日を入れてください。", "error");
  const p = selectedPeriod();
  if (p && p.from === date && p.name === $("period-name").value) return periodMessage("変わっていません。");
  if (p && p.from !== date && p.from <= stats.today && !confirm("もう始まっているマスタの切替日を変えます。前後の日の時間が変わります。よろしいですか？")) return;
  const all = allChecked();
  $("period-save").disabled = true;
  // まとめるときは、全部の区所を1回で(1つでも失敗したら、どの区所も変えない)
  const { data, error } = all
    ? await supabase.rpc("save_master_period_all", { p_old_starts_on: p ? p.from : null, p_starts_on: date, p_name: $("period-name").value })
    : await supabase.rpc("save_master_period", { p_office_id: office.id, p_period_id: p ? p.id : null, p_starts_on: date, p_name: $("period-name").value });
  $("period-save").disabled = false;
  if (error) return periodMessage(error.message, "error");
  selectedPeriodId = all ? null : data;
  await refresh();
  if (all) {
    // 選んでいる区所の、作った・直した切替日を選び直す
    const made = periodsOf(selectedOffice()).find((x) => x.from === date);
    if (made) {
      selectedPeriodId = made.id;
      renderMasterPane();
    }
  }
  const saved = selectedPeriod();
  // 直したとき: 前と後の早いほうの日から数える(作ったときは、CSV を入れるまで何も変わらないので数えない)
  const note = p ? await affectedNote(all ? null : office.id, p.from < date ? p.from : date) : "";
  const where = all ? `${data}区所の` : "";
  periodMessage((p ? where + "切替日を保存しました。" : where + "「" + periodLabel(saved || { from: date, name: "" }) + "」を作りました。" +
    (all ? "CSV は区所ごとです。区所を切り替えて、それぞれ取り込んでください。" : "続けて CSV を取り込んでください。")) +
    (note ? " " + note : ""), "ok");
});

$("period-delete").addEventListener("click", () => whileBusy("period-delete", async () => {
  const p = selectedPeriod();
  if (!p) return;
  const all = allChecked();
  const others = all ? sameDateOffices(selectedOffice(), p.from).map((o) => o.name) : [];
  // もう登録した人のカレンダーは、登録し直すまで、消すマスタの時間のまま(AB12)
  const affected = p.count ? await affectedCount(all ? null : selectedOffice().id, p.from) : 0;
  if (!confirm(`「${periodLabel(p)}」(${shortDate(p.from)}〜)のマスタを消しますか？` +
    (others.length ? `\nほかの区所(${others.join("、")})の同じ切替日のマスタも消えます。` : "") +
    `\nこのマスタの番号(${p.count}件)も消えます。切替日より後の日は、前のマスタで登録されるようになります。` +
    (affected ? `\n${shortDate(p.from)}の前日から後の勤務を、もう保存・登録している人が ${affected}人 います。その人は、その月を登録し直すと前のマスタの時間になります。` : ""))) return;
  const { data, error } = all
    ? await supabase.rpc("delete_master_period_all", { p_starts_on: p.from })
    : await supabase.rpc("delete_master_period", { p_period_id: p.id });
  if (error) return periodMessage(error.message, "error");
  selectedPeriodId = null;
  await refresh();
  periodMessage(all ? `${data}区所のマスタを消しました。` : "マスタを消しました。", "ok");
}));

$("csv-download").addEventListener("click", () => {
  const office = selectedOffice();
  const p = selectedPeriod();
  if (!office || !p) return;
  if (masterRowsOfficeId !== office.id) {
    message("この区所のマスタを読み込めていません。少し待ってから(読み込めないときは区所を選び直してから)、もう一度押してください。", "error");
    return;
  }
  const blob = new Blob([masterToCsv(masterRows.filter((r) => r.period_id === p.id))], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `shift_master_${office.name}_${p.from}${p.name ? "_" + p.name : ""}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// 選んでいる切替日のマスタを、rows で丸ごと入れ替える
async function replacePeriodRows(office, p, rows) {
  const { data, error } = await supabase.rpc("replace_shift_master", { p_office_id: office.id, p_period_id: p.id, rows });
  if (error) {
    $("csv-message").textContent = friendlyText(error.message);
    $("csv-message").className = "message error";
    return false;
  }
  const note = p.index > 0 ? await affectedNote(office.id, p.from) : "";
  await refresh();
  $("csv-message").textContent = `「${periodLabel(p)}」のマスタを ${data}件で入れ替えました。下のマスタ表で確認できます。` + (note ? " " + note : "");
  $("csv-message").className = "message ok";
  return true;
}

$("copy-prev").addEventListener("click", async () => {
  const office = selectedOffice();
  const p = selectedPeriod();
  if (!office || !p || p.index === 0 || masterRowsOfficeId !== office.id) return;
  const prev = periodsOf(office)[p.index - 1];
  const rows = masterRows.filter((r) => r.period_id === prev.id).map((r) => Object.fromEntries(MASTER_COLUMNS.map(([key]) => [key, r[key] || ""])));
  if (!rows.length) return;
  if (!confirm(`「${periodLabel(prev)}」の ${rows.length}件を、「${periodLabel(p)}」に写します(今の ${p.count}件は消えます)。\n写したあと、CSV で保存して直し、取り込み直すと楽です。よろしいですか？`)) return;
  $("copy-prev").disabled = true;
  await replacePeriodRows(office, p, rows);
  $("copy-prev").disabled = false;
});

// ---------- CSV の取り込み ----------

function clearPreview() {
  pendingRows = null;
  pendingTarget = null;
  $("csv-file").value = "";
  $("csv-preview").classList.add("hidden");
}

$("csv-file").addEventListener("change", async () => {
  const file = $("csv-file").files[0];
  $("csv-message").textContent = "";
  $("csv-preview").classList.add("hidden");
  pendingRows = null;
  if (!file) return;
  const p = selectedPeriod();
  if (!p) return;
  try {
    const rows = checkMasterRows(masterRowsFromCsv(await readTextFile(file)));
    const bad = rows.filter((r) => r.errors.length).length;
    pendingRows = rows;
    pendingTarget = { officeId: selectedOffice().id, periodId: p.id };
    renderMasterTable($("csv-rows"), rows, true);
    $("csv-summary").textContent = `${selectedOffice().name}の「${periodLabel(p)}」に ${rows.length}件を取り込みます` + (bad ? `(問題のある行: ${bad}件)` : "");
    $("csv-apply").disabled = bad > 0;
    $("csv-preview").classList.remove("hidden");
  } catch (err) {
    $("csv-message").textContent = err.message;
    $("csv-message").className = "message error";
  }
});

$("csv-cancel").addEventListener("click", clearPreview);

$("csv-apply").addEventListener("click", async () => {
  const office = selectedOffice();
  const p = selectedPeriod();
  if (!pendingRows || !office || !p) return;
  if (!pendingTarget || pendingTarget.officeId !== office.id || pendingTarget.periodId !== p.id) {
    clearPreview();
    return message("取り込む先が変わったので、確認を取り消しました。CSV を選び直してください。", "error");
  }
  if (!confirm(`${office.name}の「${periodLabel(p)}」(${rangeText(p)})のマスタを、この ${pendingRows.length}件で入れ替えます。よろしいですか？`)) return;
  $("csv-apply").disabled = true;
  const rows = pendingRows.map(({ errors: _errors, ...r }) => r);
  const ok = await replacePeriodRows(office, p, rows);
  $("csv-apply").disabled = false;
  if (ok) clearPreview();
});

// ---------- 設定 ----------

function signupMessage(text, kind) {
  $("signup-message").textContent = friendlyText(text) || "";
  $("signup-message").className = "message" + (kind ? " " + kind : "");
}

$("signup-save").addEventListener("click", async () => {
  const password = $("signup-pw").value;
  if (password.length < 8) return signupMessage("8文字以上にしてください。", "error");
  // 利用者が半角でしか入れられないので、設定も半角だけにする
  if (sharedPasswordProblem(password)) return signupMessage(sharedPasswordProblem(password), "error");
  $("signup-save").disabled = true;
  const { error } = await supabase.rpc("set_signup_password", { new_password: password });
  $("signup-save").disabled = false;
  if (error) return signupMessage(error.message, "error");
  $("signup-pw").value = "";
  signupMessage("共通パスワードを設定しました。利用者に伝えてください。", "ok");
  refresh();
});

function renderSettings() {
  $("token-status").textContent = "現在のトークンの期限: " + tokenLabel();
  $("signup-status").textContent = stats.signup_password_set
    ? "設定済みです(セキュリティのため、今のパスワードは表示できません。変えるときは新しいものを入れてください)。"
    : "まだ設定されていません。設定するまで新規登録は受け付けません。";
  $("keepalive-url").value = `${SUPABASE_URL}/rest/v1/rpc/keepalive`;
  $("keepalive-key").value = SUPABASE_ANON_KEY;
  $("copy-url").onclick = () => copyText($("keepalive-url").value, $("copy-url"));
  $("copy-key").onclick = () => copyText($("keepalive-key").value, $("copy-key"));
  $("copy-sa").onclick = () => copyText($("sa-email").value, $("copy-sa"));
}

// ---------- 読み込み ----------

async function refresh() {
  try {
    const { data, error } = await supabase.rpc("admin_stats");
    if (error) throw error;
    stats = data;
    renderOverview();
    renderUsers();
    renderOffices();
    fillOfficeSelects();
    renderSettings();
    await loadMaster();
  } catch (err) {
    message(err.message || String(err), "error");
  }
}

requireLogin("admin.html", { needAdmin: true })
  .then(async (ctx) => {
    if (!ctx) return;
    callFunction("app-config")
      .then((config) => ($("sa-email").value = config.serviceAccountEmail))
      .catch((err) => ($("sa-email").value = "取得できませんでした: " + err.message));
    // お問い合わせ・お知らせ(読み込めなくても、ほかのタブは使えるようにする)
    try {
      initContactAdmin();
      initNoticesAdmin();
      initGuideAdmin();
    } catch (err) {
      message(err.message || String(err), "error");
    }
    await refresh();
    // 前の「マスタ登録」タブ(#import)は「マスタ」にまとめた
    const tab = location.hash.replace("#", "") === "import" ? "master" : location.hash.replace("#", "");
    // 読み込みに失敗したときのメッセージ(refresh が出したもの)を、最初の showTab で消さない(G)
    if (document.getElementById("pane-" + tab)) showTab(tab, { keepMessage: true });
  })
  .catch((err) => message(err.message || String(err), "error"));
