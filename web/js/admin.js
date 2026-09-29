import { $, formatDateTime, requireLogin, supabase } from "./app.js";
import { masterRowsFromCsv, readTextFile } from "./csv.js";

let myEmail = "";
let pendingRows = null;

function message(text, kind) {
  $("message").textContent = text;
  $("message").className = kind || "";
}

function cell(tr, text, className) {
  const td = document.createElement("td");
  if (text instanceof Node) td.appendChild(text);
  else td.textContent = text;
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

async function addMember(email, note) {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("メールアドレスの形が正しくありません。");
  const { error } = await supabase.from("members").insert({ email, note: note.trim() });
  if (error) throw new Error(error.code === "23505" ? "すでに登録されています。" : error.message);
}

async function loadStats() {
  const { data, error } = await supabase.rpc("admin_stats");
  if (error) throw error;
  $("stat-members").textContent = data.members;
  $("stat-signed-in").textContent = data.signed_in;
  $("stat-verified").textContent = data.verified;
  $("stat-active").textContent = data.active_30d;

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
    cell(tr, u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : "未ログイン");
    cell(tr, u.verified ? "済" : "—");
    cell(tr, formatDateTime(u.last_registered_at));
    cell(tr, u.record_days + "日");
    const actions = document.createElement("div");
    if (u.email !== myEmail) {
      actions.appendChild(button("削除", async () => {
        if (!confirm(u.email + " の利用許可を取り消しますか？(その人の記録は残りますが、使えなくなります)")) return;
        const { error } = await supabase.from("members").delete().eq("email", u.email);
        if (error) return message(error.message, "error");
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

async function loadMaster() {
  const { data, error } = await supabase.from("shift_master").select("*").order("sort_order");
  if (error) throw error;
  const tbody = $("master");
  tbody.innerHTML = "";
  data.forEach((m) => {
    const tr = document.createElement("tr");
    cell(tr, m.code);
    cell(tr, m.kind);
    cell(tr, [m.weekday_start, m.weekday_end].filter(Boolean).join("〜"));
    cell(tr, [m.holiday_start, m.holiday_end].filter(Boolean).join("〜"));
    cell(tr, m.stay);
    tbody.appendChild(tr);
  });
  $("master-count").textContent = data.length + "件";
}

async function refresh() {
  try {
    await Promise.all([loadStats(), loadMaster()]);
  } catch (err) {
    message(err.message || String(err), "error");
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

$("csv-file").addEventListener("change", async () => {
  const file = $("csv-file").files[0];
  $("csv-message").textContent = "";
  $("csv-preview").classList.add("hidden");
  pendingRows = null;
  if (!file) return;
  try {
    const rows = masterRowsFromCsv(await readTextFile(file));
    const counts = {};
    rows.forEach((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1));
    pendingRows = rows;
    $("csv-summary").textContent = rows.length + "件(" +
      Object.entries(counts).map(([k, n]) => k + " " + n).join("、") + ")を読み込みました。";
    $("csv-preview").classList.remove("hidden");
  } catch (err) {
    $("csv-message").textContent = err.message;
    $("csv-message").className = "error";
  }
});

$("csv-cancel").addEventListener("click", () => {
  pendingRows = null;
  $("csv-file").value = "";
  $("csv-preview").classList.add("hidden");
});

$("csv-apply").addEventListener("click", async () => {
  if (!pendingRows) return;
  $("csv-apply").disabled = true;
  const { data, error } = await supabase.rpc("replace_shift_master", { rows: pendingRows });
  $("csv-apply").disabled = false;
  if (error) {
    $("csv-message").textContent = error.message;
    $("csv-message").className = "error";
    return;
  }
  $("csv-message").textContent = data + "件でマスタを入れ替えました。";
  $("csv-message").className = "ok";
  $("csv-preview").classList.add("hidden");
  $("csv-file").value = "";
  pendingRows = null;
  loadMaster();
});

requireLogin("admin.html", { needAdmin: true })
  .then((ctx) => {
    if (!ctx) return;
    myEmail = ctx.member.email;
    refresh();
  })
  .catch((err) => message(err.message || String(err), "error"));
