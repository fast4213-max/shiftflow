// 管理画面。管理者フラグ + パスワード解除(DB 側で判定)が必要。
import { $, formatDateTime, requireLogin, supabase } from "./app.js";
import { checkMasterRows, masterRowsFromCsv, masterToCsv, readTextFile } from "./csv.js";

const MASTER_COLUMNS = [
  ["code", "番号"],
  ["kind", "種別"],
  ["weekday_start", "平日出勤"],
  ["weekday_end", "平日退勤"],
  ["holiday_start", "休日出勤"],
  ["holiday_end", "休日退勤"],
  ["stay", "泊"],
];

let myEmail = "";
let offices = [];
let currentMaster = [];
let pendingRows = null;

function message(text, kind) {
  $("message").textContent = text;
  $("message").className = kind || "";
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

function friendly(error) {
  const text = (error && error.message) || String(error);
  if (text.includes("管理者だけ") || text.includes("row-level security")) {
    return "パスワードの解除が切れました。ページを開き直して、もう一度パスワードを入れてください。";
  }
  return text;
}

// ---------- パスワード ----------

async function isUnlocked() {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) throw error;
  return data === true;
}

function showLocked(text, kind) {
  $("admin-body").classList.add("hidden");
  $("lock").classList.add("hidden");
  $("lock-screen").classList.remove("hidden");
  $("unlock-message").textContent = text || "";
  $("unlock-message").className = kind || "";
  $("passcode").focus();
}

function showUnlocked() {
  $("lock-screen").classList.add("hidden");
  $("admin-body").classList.remove("hidden");
  $("lock").classList.remove("hidden");
  refresh();
}

$("unlock-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { data, error } = await supabase.rpc("unlock_admin", { passcode: $("passcode").value });
  $("passcode").value = "";
  if (error) return showLocked(error.message, "error");
  const messages = {
    wrong: "パスワードが違います。",
    locked: "続けて間違えたため、15分間ロックしています。",
    not_set: "パスワードがまだ設定されていません。README の手順で、SQL Editor から設定してください。",
    not_admin: "管理者ではありません。",
  };
  if (data === "ok") showUnlocked();
  else showLocked(messages[data] || data, "error");
});

$("lock").addEventListener("click", async () => {
  await supabase.rpc("lock_admin");
  showLocked("ロックしました。");
});

// ---------- 利用状況・利用者・区所 ----------

async function addMember(email, note) {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("メールアドレスの形が正しくありません。");
  const { error } = await supabase.from("members").insert({ email, note: note.trim() });
  if (error) throw new Error(error.code === "23505" ? "すでに登録されています。" : friendly(error));
}

function renderUsers(data) {
  const users = $("users");
  users.innerHTML = "";
  data.users.forEach((u) => {
    const tr = document.createElement("tr");
    const who = document.createElement("div");
    const mail = document.createElement("div");
    mail.className = "mono";
    mail.textContent = u.email + (u.is_admin ? "(管理者)" : "");
    who.appendChild(mail);
    if (u.note) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = u.note;
      who.appendChild(note);
    }
    cell(tr, who);
    cell(tr, u.office || "—");
    cell(tr, u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : "未ログイン");
    cell(tr, u.verified ? "済" : "—");
    cell(tr, formatDateTime(u.last_registered_at));
    cell(tr, u.record_days + "日");
    const actions = document.createElement("div");
    if (u.email !== myEmail) {
      actions.appendChild(button("削除", async () => {
        if (!confirm(u.email + " の利用許可を取り消しますか？(その人の記録は残りますが、使えなくなります)")) return;
        const { error } = await supabase.from("members").delete().eq("email", u.email);
        if (error) return message(friendly(error), "error");
        refresh();
      }));
    }
    cell(tr, actions);
    users.appendChild(tr);
  });

  const pending = $("pending");
  pending.innerHTML = "";
  $("pending-box").classList.toggle("hidden", data.pending.length === 0);
  data.pending.forEach((p) => {
    const tr = document.createElement("tr");
    cell(tr, p.email, "mono");
    cell(tr, formatDateTime(p.last_sign_in_at));
    cell(tr, button("許可", async () => {
      try {
        await addMember(p.email, "");
        refresh();
      } catch (err) {
        message(err.message, "error");
      }
    }, "primary"));
    pending.appendChild(tr);
  });
}

function renderOffices(list) {
  offices = list;
  const tbody = $("offices");
  tbody.innerHTML = "";
  list.forEach((o) => {
    const tr = document.createElement("tr");
    cell(tr, o.name);
    cell(tr, o.master_count + "件");
    cell(tr, o.user_count + "人");
    const actions = document.createElement("div");
    actions.className = "row";
    actions.appendChild(button("名前変更", async () => {
      const name = prompt("新しい名前", o.name);
      if (!name || !name.trim() || name.trim() === o.name) return;
      const { error } = await supabase.from("offices").update({ name: name.trim() }).eq("id", o.id);
      if (error) return message(error.code === "23505" ? "同じ名前の区所があります。" : friendly(error), "error");
      refresh();
    }));
    actions.appendChild(button("削除", async () => {
      const warn = o.name + " を削除しますか？\nこの区所のマスタ(" + o.master_count + "件)も消え、" +
        "選んでいる利用者(" + o.user_count + "人)は区所を選び直すまで登録できなくなります。";
      if (!confirm(warn)) return;
      const { error } = await supabase.from("offices").delete().eq("id", o.id);
      if (error) return message(friendly(error), "error");
      refresh();
    }));
    cell(tr, actions);
    tbody.appendChild(tr);
  });

  // マスタの区所の選択肢(選んでいたものは保つ)
  const select = $("master-office");
  const keep = select.value;
  select.innerHTML = "";
  list.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.name + "(" + o.master_count + "件)";
    select.appendChild(opt);
  });
  if (list.some((o) => String(o.id) === keep)) select.value = keep;
  $("csv-file").disabled = list.length === 0;
  if (list.length === 0) {
    $("csv-message").textContent = "先に「区所」で区所を追加してください。";
    $("csv-message").className = "muted";
  }
}

async function refresh() {
  try {
    const { data, error } = await supabase.rpc("admin_stats");
    if (error) throw error;
    $("stat-members").textContent = data.members;
    $("stat-signed-in").textContent = data.signed_in;
    $("stat-verified").textContent = data.verified;
    $("stat-active").textContent = data.active_30d;
    renderUsers(data);
    renderOffices(data.offices);
    await loadMaster();
  } catch (err) {
    message(friendly(err), "error");
  }
}

$("add-member").addEventListener("click", async () => {
  try {
    await addMember($("new-email").value, $("new-note").value);
    $("new-email").value = "";
    $("new-note").value = "";
    message("追加しました。本人に、アプリのURLを開いてGoogleでログインするよう伝えてください。", "ok");
    refresh();
  } catch (err) {
    message(err.message, "error");
  }
});

$("add-office").addEventListener("click", async () => {
  const name = $("new-office").value.trim();
  if (!name) return;
  const { error } = await supabase.from("offices").insert({ name, sort_order: offices.length + 1 });
  if (error) return message(error.code === "23505" ? "同じ名前の区所があります。" : friendly(error), "error");
  $("new-office").value = "";
  message("区所を追加しました。続けて下の「勤務コードマスタ」でこの区所の CSV を取り込んでください。", "ok");
  refresh();
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

function selectedOffice() {
  return offices.find((o) => String(o.id) === $("master-office").value);
}

async function loadMaster() {
  const office = selectedOffice();
  if (!office) {
    currentMaster = [];
    renderMasterTable($("master"), [], false);
    $("master-title").textContent = "いまのマスタ";
    $("master-count").textContent = "";
    return;
  }
  const { data, error } = await supabase.from("shift_master").select("*").eq("office_id", office.id).order("sort_order");
  if (error) throw error;
  currentMaster = data;
  $("master-title").textContent = "いまのマスタ: " + office.name;
  renderMasterTable($("master"), data, false);
  const counts = {};
  data.forEach((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1));
  $("master-count").textContent = data.length + "件" +
    (data.length ? "(" + Object.entries(counts).map(([k, n]) => k + " " + n).join("、") + ")" : "");
}

function clearPreview() {
  pendingRows = null;
  $("csv-file").value = "";
  $("csv-preview").classList.add("hidden");
}

$("master-office").addEventListener("change", () => {
  clearPreview();
  $("csv-message").textContent = "";
  loadMaster().catch((err) => message(friendly(err), "error"));
});

$("csv-file").addEventListener("change", async () => {
  const file = $("csv-file").files[0];
  $("csv-message").textContent = "";
  $("csv-preview").classList.add("hidden");
  pendingRows = null;
  if (!file) return;
  const office = selectedOffice();
  try {
    const rows = checkMasterRows(masterRowsFromCsv(await readTextFile(file)));
    const bad = rows.filter((r) => r.errors.length).length;
    pendingRows = rows;
    renderMasterTable($("csv-rows"), rows, true);
    $("csv-summary").textContent = office.name + " に " + rows.length + "件を取り込みます" +
      (bad ? "(問題のある行: " + bad + "件)" : "");
    $("csv-apply").disabled = bad > 0;
    $("csv-preview").classList.remove("hidden");
  } catch (err) {
    $("csv-message").textContent = err.message;
    $("csv-message").className = "error";
  }
});

$("csv-cancel").addEventListener("click", clearPreview);

$("csv-apply").addEventListener("click", async () => {
  const office = selectedOffice();
  if (!pendingRows || !office) return;
  if (!confirm(office.name + " のマスタを、この " + pendingRows.length + "件で入れ替えます。よろしいですか？")) return;
  $("csv-apply").disabled = true;
  const rows = pendingRows.map(({ errors: _errors, ...r }) => r);
  const { data, error } = await supabase.rpc("replace_shift_master", { p_office_id: office.id, rows });
  $("csv-apply").disabled = false;
  if (error) {
    $("csv-message").textContent = friendly(error);
    $("csv-message").className = "error";
    return;
  }
  clearPreview();
  $("csv-message").textContent = office.name + " のマスタを " + data + "件で入れ替えました。下の表で確認してください。";
  $("csv-message").className = "ok";
  refresh();
});

$("csv-download").addEventListener("click", () => {
  const office = selectedOffice();
  if (!office) return;
  const blob = new Blob([masterToCsv(currentMaster)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "shift_master_" + office.name + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- 入口 ----------

requireLogin("admin.html", { needAdmin: true })
  .then(async (ctx) => {
    if (!ctx) return;
    myEmail = ctx.member.email;
    if (await isUnlocked()) showUnlocked();
    else showLocked();
  })
  .catch((err) => message(friendly(err), "error"));
