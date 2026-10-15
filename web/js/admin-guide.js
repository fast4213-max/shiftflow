// 管理画面の「お知らせ」タブの上の枠: 使い方リンク(動画・文書)を足す・直す・消す・並べ替える・隠す。
// 書けるのは管理者だけ(DB の RLS)。https:// と10件までは DB でも確かめる
import { friendlyText, $, supabase } from "./app.js?v=dev";

const LABEL_MAX = 20;
const URL_MAX = 500;
const LINK_MAX = 10;

let editingId = null;
let links = [];
let busy = false;

function setMessage(text, kind) {
  $("guide-message").textContent = friendlyText(text) || "";
  $("guide-message").className = "message" + (kind ? " " + kind : "");
}

function resetForm() {
  editingId = null;
  $("guide-label").value = "";
  $("guide-url").value = "";
  document.querySelector('input[name="guide-kind"][value="video"]').checked = true;
  $("guide-form-title").textContent = "使い方リンク(ログイン画面の「はじめての方へ」)";
  $("guide-save").textContent = "追加する";
  $("guide-cancel").classList.add("hidden");
}

function edit(g) {
  editingId = g.id;
  $("guide-label").value = g.label;
  $("guide-url").value = g.url;
  document.querySelector(`input[name="guide-kind"][value="${g.kind === "doc" ? "doc" : "video"}"]`).checked = true;
  $("guide-form-title").textContent = "使い方リンクを直す";
  $("guide-save").textContent = "直して保存";
  $("guide-cancel").classList.remove("hidden");
  setMessage("");
  $("guide-label").scrollIntoView({ block: "center" });
}

function button(text, onClick, title) {
  const b = document.createElement("button");
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

async function load() {
  const { data, error } = await supabase.from("guide_links").select("*").order("sort_order").order("id");
  const box = $("guide-list");
  box.innerHTML = "";
  if (error) {
    box.textContent = "読み込めませんでした: " + error.message;
    return;
  }
  links = data;
  if (!links.length) {
    box.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: "まだ登録がありません。登録するまで、ログイン画面に枠は出ません。" }));
    return;
  }
  links.forEach((g, index) => {
    const row = document.createElement("div");
    row.className = "notice-admin-row";
    const head = document.createElement("div");
    head.className = "row";
    const badge = document.createElement("span");
    badge.className = "status-badge " + (g.visible ? "active" : "ended");
    badge.textContent = g.visible ? "表示中" : "非表示";
    const name = document.createElement("strong");
    name.textContent = (g.kind === "doc" ? "📄 " : "▶ ") + g.label;
    const up = button("↑", () => move(g, -1), "1つ上へ");
    const down = button("↓", () => move(g, 1), "1つ下へ");
    up.disabled = index === 0;
    down.disabled = index === links.length - 1;
    head.append(badge, name, up, down,
      button("編集", () => edit(g)),
      button(g.visible ? "隠す" : "表示する", () => toggle(g)),
      button("削除", () => remove(g)));
    const url = document.createElement("div");
    url.className = "muted small";
    url.style.overflowWrap = "anywhere";
    url.textContent = g.url;
    row.append(head, url);
    box.appendChild(row);
  });
}

// 通信中はほかの操作を受けない(連打・並べ替えの途中の操作で、古い並びを上書きしないため)
async function run(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("#guide-list button, #guide-save").forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    setMessage(err.message || String(err), "error");
  } finally {
    busy = false;
    $("guide-save").disabled = false;
    await load();
  }
}

const move = (g, delta) => run(async () => {
  const { error } = await supabase.rpc("move_guide_link", { p_id: g.id, p_delta: delta });
  if (error) setMessage(error.message, "error");
});

const toggle = (g) => run(async () => {
  const { data, error } = await supabase.from("guide_links").update({ visible: !g.visible }).eq("id", g.id).select("id");
  if (error) return setMessage(error.message, "error");
  if (!(data && data.length)) return setMessage("リンクが見つかりません(ほかの画面で消されたかもしれません)。", "error");
  setMessage(g.visible ? "隠しました。" : "表示しました。", "ok");
});

const remove = (g) => run(async () => {
  if (!confirm(`「${g.label}」を削除しますか？`)) return;
  const { error } = await supabase.from("guide_links").delete().eq("id", g.id);
  if (error) return setMessage(error.message, "error");
  if (editingId === g.id) resetForm();
  setMessage("削除しました。", "ok");
});

function validUrl(text) {
  if (!/^https:\/\/[^\s<>"']+$/.test(text) || [...text].length > URL_MAX) return false;
  try {
    return new URL(text).protocol === "https:";
  } catch (_) {
    return false;
  }
}

const save = () => run(async () => {
  const label = $("guide-label").value.trim();
  const url = $("guide-url").value.trim();
  const kind = document.querySelector('input[name="guide-kind"]:checked').value;
  if (!label) return setMessage("表示名を入力してください。", "error");
  if ([...label].length > LABEL_MAX) return setMessage(`表示名は${LABEL_MAX}文字以内にしてください。`, "error");
  if (!validUrl(url)) return setMessage("リンクは https:// から始まるものを入れてください(空白は入れられません)。", "error");
  if (!editingId && links.length >= LINK_MAX) return setMessage(`使い方リンクは${LINK_MAX}件までです。`, "error");
  if (editingId) {
    const { data, error } = await supabase.from("guide_links").update({ label, url, kind }).eq("id", editingId).select("id");
    if (error) return setMessage(error.message, "error");
    if (!(data && data.length)) {
      // 書いた内容は残し、新しく足すフォームに切り替える
      editingId = null;
      $("guide-form-title").textContent = "使い方リンク(ログイン画面の「はじめての方へ」)";
      $("guide-save").textContent = "追加する";
      $("guide-cancel").classList.add("hidden");
      return setMessage("このリンクが見つかりません(ほかの画面で消されたかもしれません)。直した内容は保存していません。もう一度押すと、新しく追加します。", "error");
    }
    setMessage("直しました。", "ok");
  } else {
    const top = links.reduce((m, g) => Math.max(m, g.sort_order), 0);
    const { error } = await supabase.from("guide_links").insert({ label, url, kind, sort_order: top + 1 });
    if (error) return setMessage(error.message, "error");
    setMessage("追加しました。ログイン画面などに出ます。", "ok");
  }
  resetForm();
});

export function initGuideAdmin() {
  resetForm();
  $("guide-save").addEventListener("click", () => save());
  $("guide-cancel").addEventListener("click", () => {
    resetForm();
    setMessage("");
  });
  document.querySelector('.dtab[data-tab="notices"]').addEventListener("click", () => load());
  load();
}
