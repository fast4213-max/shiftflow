// 管理画面の「お知らせ」タブ: お知らせを出す・直す・消す(管理者だけ。DB の RLS で守られている)
import { $, noticeElement, supabase } from "./app.js?v=dev";

let editingId = null;

function setMessage(text, kind) {
  $("notice-message").textContent = text || "";
  $("notice-message").className = "message" + (kind ? " " + kind : "");
}

// 日本時間の今日(YYYY-MM-DD)
function todayJst() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function state(n) {
  const today = todayJst();
  if (n.starts_on > today) return ["予定", "planned"];
  if (n.ends_on && n.ends_on < today) return ["終了", "ended"];
  return ["表示中", "active"];
}

function resetForm() {
  editingId = null;
  $("notice-title").value = "";
  $("notice-body").value = "";
  document.querySelector('input[name="notice-level"][value="info"]').checked = true;
  $("notice-start").value = todayJst();
  $("notice-end").value = "";
  $("notice-form-title").textContent = "お知らせを出す";
  $("notice-save").textContent = "保存して公開";
  $("notice-cancel").classList.add("hidden");
}

function edit(n) {
  editingId = n.id;
  $("notice-title").value = n.title;
  $("notice-body").value = n.body || "";
  document.querySelector(`input[name="notice-level"][value="${n.level === "important" ? "important" : "info"}"]`).checked = true;
  $("notice-start").value = n.starts_on;
  $("notice-end").value = n.ends_on || "";
  $("notice-form-title").textContent = "お知らせを直す";
  $("notice-save").textContent = "直して保存";
  $("notice-cancel").classList.remove("hidden");
  setMessage("");
  $("notice-title").scrollIntoView({ block: "center" });
}

async function loadNotices() {
  const { data, error } = await supabase.from("notices").select("*")
    .order("starts_on", { ascending: false }).order("id", { ascending: false });
  const box = $("notice-list");
  box.innerHTML = "";
  if (error) {
    box.textContent = "読み込めませんでした: " + error.message;
    return;
  }
  if (!data.length) {
    box.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: "まだお知らせはありません。" }));
    return;
  }
  data.forEach((n) => {
    const row = document.createElement("div");
    row.className = "notice-admin-row";
    const [label, cls] = state(n);
    const head = document.createElement("div");
    head.className = "row";
    const badge = document.createElement("span");
    badge.className = "status-badge " + cls;
    badge.textContent = label;
    const period = document.createElement("span");
    period.className = "muted small";
    period.textContent = `${n.starts_on} 〜 ${n.ends_on || "(終わりなし)"}`;
    const editBtn = document.createElement("button");
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => edit(n));
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`「${n.title}」を削除しますか？`)) return;
      const { error: delError } = await supabase.from("notices").delete().eq("id", n.id);
      if (delError) return setMessage(delError.message, "error");
      if (editingId === n.id) resetForm();
      setMessage("削除しました。", "ok");
      loadNotices();
    });
    head.append(badge, period, editBtn, delBtn);
    row.append(head, noticeElement(n));
    box.appendChild(row);
  });
}

async function save() {
  const title = $("notice-title").value.trim();
  const body = $("notice-body").value.trim();
  const level = document.querySelector('input[name="notice-level"]:checked').value;
  const startsOn = $("notice-start").value || todayJst();
  const endsOn = $("notice-end").value || null;
  if (!title) return setMessage("タイトルを入力してください。", "error");
  if ([...title].length > 100) return setMessage("タイトルは100文字以内にしてください。", "error");
  if ([...body].length > 1000) return setMessage("本文は1000文字以内にしてください。", "error");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn))) {
    return setMessage("日付の形が正しくありません。", "error");
  }
  if (endsOn && endsOn < startsOn) return setMessage("終わりの日は、始まりの日より後にしてください。", "error");
  $("notice-save").disabled = true;
  const row = { title, body, level, starts_on: startsOn, ends_on: endsOn };
  const { error } = editingId
    ? await supabase.from("notices").update(row).eq("id", editingId)
    : await supabase.from("notices").insert(row);
  $("notice-save").disabled = false;
  if (error) return setMessage(error.message, "error");
  const today = todayJst();
  const note = startsOn > today ? `${startsOn} から表示されます。` : endsOn && endsOn < today ? "期間が過ぎているので表示されません。" : "ログイン画面などに表示されます。";
  setMessage((editingId ? "直しました。" : "公開しました。") + note, "ok");
  resetForm();
  loadNotices();
}

export function initNoticesAdmin() {
  resetForm();
  $("notice-save").addEventListener("click", () => save().catch((err) => {
    $("notice-save").disabled = false;
    setMessage(err.message || String(err), "error");
  }));
  $("notice-cancel").addEventListener("click", () => {
    resetForm();
    setMessage("");
  });
  document.querySelector('.dtab[data-tab="notices"]').addEventListener("click", () => loadNotices());
  loadNotices();
}
