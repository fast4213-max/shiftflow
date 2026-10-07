// 管理画面(ダッシュボード)。管理者だけ。管理用パスワードでログインしたセッションで動く。
import { friendlyText, $, callFunction, copyText, formatDateTime, requireLogin, sharedPasswordProblem, supabase } from "./app.js?v=dev";
import { SUPABASE_ANON_KEY, SUPABASE_URL, TOKEN_EXPIRES } from "./config.js?v=dev";
import { checkMasterRows, masterRowsFromCsv, masterToCsv, readTextFile } from "./csv.js?v=dev";
import { initContactAdmin } from "./admin-contact.js?v=dev";
import { initNoticesAdmin } from "./admin-notices.js?v=dev";

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
];

// 区所の名前の長さの上限(お問い合わせの「所属」に写すときの上限と同じ。Q9)
const OFFICE_NAME_MAX = 60;

let stats = null;
let currentMaster = [];
let pendingRows = null;

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
function tokenDaysLeft() {
  const end = new Date(TOKEN_EXPIRES + "T23:59:59+09:00");
  return Math.ceil((end - new Date()) / 86400000);
}

function tokenLabel() {
  const [y, m, d] = TOKEN_EXPIRES.split("-").map(Number);
  const left = tokenDaysLeft();
  const date = `${y}年${m}月${d}日`;
  if (left < 0) return `${date}(期限が切れています。新しいトークンを作ってください)`;
  return `${date}(あと${left}日)`;
}

function alertBox(kind, text, actionLabel, tab) {
  const div = document.createElement("div");
  div.className = "alert " + kind;
  const span = document.createElement("span");
  span.textContent = text;
  div.appendChild(span);
  if (actionLabel) div.appendChild(button(actionLabel, () => showTab(tab)));
  return div;
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
    alerts.appendChild(alertBox("warn", "区所がまだありません。区所を追加して、マスタを取り込んでください。", "マスタ登録へ", "import"));
  } else {
    const empty = stats.offices.filter((o) => o.master_count === 0);
    if (empty.length) {
      alerts.appendChild(alertBox("warn", "マスタが空の区所があります: " + empty.map((o) => o.name).join("、"), "マスタ登録へ", "import"));
    }
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

function renderUsers() {
  const query = $("user-search").value.trim().toLowerCase().replace(/\s+/g, "");
  const list = stats.users_list.filter((u) =>
    !query || (u.employee_no + fullName(u)).toLowerCase().replace(/\s+/g, "").includes(query)
  );
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
$("pin-close").addEventListener("click", () => {
  $("pin-dialog").close();
  $("pin-value").textContent = "";
});

// ---------- 区所 ----------

function fillOfficeSelects() {
  ["view-office", "import-office"].forEach((id) => {
    const select = $(id);
    const keep = select.value;
    select.innerHTML = "";
    stats.offices.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = `${o.name}(${o.master_count}件)`;
      select.appendChild(opt);
    });
    if (stats.offices.some((o) => String(o.id) === keep)) select.value = keep;
    // 取り込み先の区所が消されて別の区所に変わったら、確認中の CSV は取り消す(別の区所のマスタを入れ替えないように)
    if (id === "import-office" && pendingRows && select.value !== keep) clearPreview();
  });
  $("csv-file").disabled = stats.offices.length === 0;
  $("csv-download").disabled = stats.offices.length === 0;
}

function renderOffices() {
  const tbody = $("offices");
  tbody.innerHTML = "";
  stats.offices.forEach((o) => {
    const tr = document.createElement("tr");
    cell(tr, o.name);
    cell(tr, o.master_count + "件");
    cell(tr, o.user_count + "人");
    const actions = document.createElement("div");
    actions.append(
      button("名前変更", async () => {
        const name = prompt("新しい名前(60文字まで)", o.name);
        if (!name || !name.trim() || name.trim() === o.name) return;
        if ([...name.trim()].length > OFFICE_NAME_MAX) return message(`区所の名前は${OFFICE_NAME_MAX}文字までにしてください。`, "error");
        const { error } = await supabase.from("offices").update({ name: name.trim() }).eq("id", o.id);
        if (error) return message(error.code === "23505" ? "同じ名前の区所があります。" : error.message, "error");
        refresh();
      }),
      button("削除", async () => {
        const warn = `${o.name} を削除しますか？\nこの区所のマスタ(${o.master_count}件)も消え、選んでいる利用者(${o.user_count}人)は区所を選び直すまで登録できなくなります。`;
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

$("add-office").addEventListener("click", async () => {
  const name = $("new-office").value.trim();
  if (!name) return;
  if ([...name].length > OFFICE_NAME_MAX) return message(`区所の名前は${OFFICE_NAME_MAX}文字までにしてください。`, "error");
  const { error } = await supabase.from("offices").insert({ name, sort_order: stats.offices.length + 1 });
  if (error) return message(error.code === "23505" ? "同じ名前の区所があります。" : error.message, "error");
  $("new-office").value = "";
  message("区所を追加しました。下の「CSV を取り込む」でこの区所のマスタを入れてください。", "ok");
  await refresh();
});

// ---------- マスタの表 ----------

function renderMasterTable(tbody, rows, withErrors) {
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

  tbody.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (withErrors && r.errors.length) tr.className = "bad";
    cell(tr, i + 1, "num");
    if (withErrors) cell(tr, r.errors.length ? r.errors.join(" / ") : "OK", r.errors.length ? "err" : "ok");
    MASTER_COLUMNS.forEach(([key]) => cell(tr, r[key]));
    tbody.appendChild(tr);
  });
}

async function loadMaster() {
  const office = stats.offices.find((o) => String(o.id) === $("view-office").value);
  if (!office) {
    currentMaster = [];
    renderMasterTable($("master"), [], false);
    $("master-count").textContent = "";
    return;
  }
  const { data, error } = await supabase.from("shift_master").select("*").eq("office_id", office.id).order("sort_order");
  if (error) throw error;
  currentMaster = data;
  renderMasterTable($("master"), data, false);
  const counts = {};
  data.forEach((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1));
  $("master-count").textContent = `${office.name}: ${data.length}件` +
    (data.length ? "(" + Object.entries(counts).map(([k, n]) => `${k} ${n}`).join("、") + ")" : "");
}
$("view-office").addEventListener("change", () => loadMaster().catch((err) => message(err.message, "error")));

$("csv-download").addEventListener("click", () => {
  const office = stats.offices.find((o) => String(o.id) === $("view-office").value);
  if (!office) return;
  const blob = new Blob([masterToCsv(currentMaster)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `shift_master_${office.name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- マスタ登録(CSV) ----------

function clearPreview() {
  pendingRows = null;
  $("csv-file").value = "";
  $("csv-preview").classList.add("hidden");
}

function selectedImportOffice() {
  return stats.offices.find((o) => String(o.id) === $("import-office").value);
}

$("import-office").addEventListener("change", () => {
  clearPreview();
  $("csv-message").textContent = "";
});

$("csv-file").addEventListener("change", async () => {
  const file = $("csv-file").files[0];
  $("csv-message").textContent = "";
  $("csv-preview").classList.add("hidden");
  pendingRows = null;
  if (!file) return;
  const office = selectedImportOffice();
  try {
    const rows = checkMasterRows(masterRowsFromCsv(await readTextFile(file)));
    const bad = rows.filter((r) => r.errors.length).length;
    pendingRows = rows;
    renderMasterTable($("csv-rows"), rows, true);
    $("csv-summary").textContent = `${office.name} に ${rows.length}件を取り込みます` + (bad ? `(問題のある行: ${bad}件)` : "");
    $("csv-apply").disabled = bad > 0;
    $("csv-preview").classList.remove("hidden");
  } catch (err) {
    $("csv-message").textContent = err.message;
    $("csv-message").className = "message error";
  }
});

$("csv-cancel").addEventListener("click", clearPreview);

$("csv-apply").addEventListener("click", async () => {
  const office = selectedImportOffice();
  if (!pendingRows || !office) return;
  if (!confirm(`${office.name} のマスタを、この ${pendingRows.length}件で入れ替えます。よろしいですか？`)) return;
  $("csv-apply").disabled = true;
  const rows = pendingRows.map(({ errors: _errors, ...r }) => r);
  const { data, error } = await supabase.rpc("replace_shift_master", { p_office_id: office.id, rows });
  $("csv-apply").disabled = false;
  if (error) {
    $("csv-message").textContent = error.message;
    $("csv-message").className = "message error";
    return;
  }
  clearPreview();
  $("csv-message").textContent = `${office.name} のマスタを ${data}件で入れ替えました。「マスタ表」で確認できます。`;
  $("csv-message").className = "message ok";
  refresh();
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
    } catch (err) {
      message(err.message || String(err), "error");
    }
    await refresh();
    const tab = location.hash.replace("#", "");
    // 読み込みに失敗したときのメッセージ(refresh が出したもの)を、最初の showTab で消さない(G)
    if (document.getElementById("pane-" + tab)) showTab(tab, { keepMessage: true });
  })
  .catch((err) => message(err.message || String(err), "error"));
