// 管理画面の「設定」タブ: カレンダーのホーム画面のアイコンを足す・名前を直す・並べ替える・隠す・消す。
// 画像は、ここで真ん中を正方形に切り取り、512・192・180px の PNG にして Storage の app-icons/<id>/ に入れる。
// 書けるのは管理者だけ(DB の RLS・Storage の権限)。20件までは DB でも確かめる
import { friendlyText, $, supabase } from "./app.js?v=dev";

const NAME_MAX = 20;
const ICON_MAX = 20;
const SIZES = [512, 192, 180];
const MIN_SIDE = 192;
const BUCKET = "app-icons";

let editingId = null;
let icons = [];
let busy = false;
let picked = null; // 選んだ画像(読み込み済みの ImageBitmap か <img>)

const pub = (path) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

function setMessage(text, kind, raw = false) {
  $("icon-message").textContent = (raw ? text : friendlyText(text)) || "";
  $("icon-message").className = "message" + (kind ? " " + kind : "");
}

function resetForm() {
  editingId = null;
  picked = null;
  $("icon-name").value = "";
  $("icon-file").value = "";
  $("icon-file-row").classList.remove("hidden");
  $("icon-preview").hidden = true;
  $("icon-form-title").textContent = "カレンダーのホーム画面のアイコン";
  $("icon-save").textContent = "追加する";
  $("icon-cancel").classList.add("hidden");
}

function edit(ic) {
  editingId = ic.id;
  picked = null;
  $("icon-name").value = ic.name;
  $("icon-file-row").classList.add("hidden"); // 画像は直せない(入れ替えたいときは、消して足し直す)
  $("icon-form-title").textContent = "アイコンの名前を直す";
  $("icon-save").textContent = "直して保存";
  $("icon-cancel").classList.remove("hidden");
  setMessage("");
  $("icon-name").scrollIntoView({ block: "center" });
}

function button(text, onClick, title) {
  const b = document.createElement("button");
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

async function load() {
  const { data, error } = await supabase.from("app_icons").select("*").order("sort_order").order("id");
  const box = $("icon-list");
  box.innerHTML = "";
  if (error) {
    box.textContent = "読み込めませんでした: " + friendlyText(error.message);
    return;
  }
  icons = data;
  if (!icons.length) {
    box.appendChild(Object.assign(document.createElement("p"), { className: "muted", textContent: "まだ足したアイコンはありません(はじめから入っている4つだけが選べます)。" }));
    return;
  }
  icons.forEach((ic, index) => {
    const row = document.createElement("div");
    row.className = "notice-admin-row";
    const head = document.createElement("div");
    head.className = "row";
    const img = document.createElement("img");
    img.src = pub(`${ic.id}/192.png`);
    img.alt = "";
    img.width = 40;
    img.height = 40;
    img.style.borderRadius = "9px";
    const badge = document.createElement("span");
    badge.className = "status-badge " + (ic.visible ? "active" : "ended");
    badge.textContent = ic.visible ? "表示中" : "非表示";
    const name = document.createElement("strong");
    name.textContent = ic.name;
    const up = button("↑", () => move(ic, -1), "1つ上へ");
    const down = button("↓", () => move(ic, 1), "1つ下へ");
    up.disabled = index === 0;
    down.disabled = index === icons.length - 1;
    head.append(img, badge, name, up, down,
      button("名前を直す", () => edit(ic)),
      button(ic.visible ? "隠す" : "表示する", () => toggle(ic)),
      button("削除", () => remove(ic)));
    row.append(head);
    box.appendChild(row);
  });
}

// 通信中は他の操作を受けない(連打・並べ替えの途中の操作で、古い並びを上書きしないため)
async function run(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("#icon-list button, #icon-save").forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    setMessage(err.message || String(err), "error");
  } finally {
    busy = false;
    $("icon-save").disabled = false;
    await load();
  }
}

const move = (ic, delta) => run(async () => {
  const { error } = await supabase.rpc("move_app_icon", { p_id: ic.id, p_delta: delta });
  if (error) setMessage(error.message, "error");
});

const toggle = (ic) => run(async () => {
  const { data, error } = await supabase.from("app_icons").update({ visible: !ic.visible }).eq("id", ic.id).select("id");
  if (error) return setMessage(error.message, "error");
  if (!(data && data.length)) return setMessage("アイコンが見つかりません(他の画面で消されたかもしれません)。", "error");
  setMessage(ic.visible ? "隠しました。利用者の選ぶ一覧から消えます(すでに選んでいる人は、開き直すと今のアイコンに戻ります)。" : "表示しました。", "ok");
});

const remove = (ic) => run(async () => {
  if (!confirm(`「${ic.name}」を削除しますか？\n選んでいる人は、開き直すと今のアイコンに戻ります(すでにホーム画面にあるアイコンは変わりません)。`)) return;
  const { error } = await supabase.from("app_icons").delete().eq("id", ic.id);
  if (error) return setMessage(error.message, "error");
  // 画像は、行を消したあとに消す(消せなくても、行が無いので使われない)
  await supabase.storage.from(BUCKET).remove(SIZES.map((n) => `${ic.id}/${n}.png`));
  if (editingId === ic.id) resetForm();
  setMessage("削除しました。", "ok");
});

// ---------- 画像 ----------

async function readImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch (_) { /* 読めない形式。下の <img> でも試す */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sideOf = (img) => ({ w: img.width || img.naturalWidth, h: img.height || img.naturalHeight });

// 真ん中を正方形に切り取って、size px の canvas に描く(透明は白で塗る。iPhone は透明を黒にするため)
function draw(img, size) {
  const { w, h } = sideOf(img);
  const side = Math.min(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  return canvas;
}

const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))), "image/png"));

async function onFile() {
  picked = null;
  $("icon-preview").hidden = true;
  const file = $("icon-file").files[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1048576) throw new Error("画像が大きすぎます(20MBまで)。");
    const img = await readImage(file);
    const { w, h } = sideOf(img);
    if (Math.min(w, h) < MIN_SIDE) throw new Error(`画像が小さすぎます(短い辺が ${MIN_SIDE}px 以上のものを選んでください)。`);
    picked = img;
    const c = $("icon-preview");
    c.hidden = false;
    c.getContext("2d").drawImage(draw(img, 96), 0, 0);
    setMessage("");
  } catch (err) {
    $("icon-file").value = "";
    setMessage(err.message || "この画像は読めません。PNG・JPEG・WebP を選んでください。", "error");
  }
}

const save = () => run(async () => {
  const name = $("icon-name").value.trim();
  if (!name) return setMessage("名前を入力してください。", "error");
  if ([...name].length > NAME_MAX) return setMessage(`名前は${NAME_MAX}文字以内にしてください。`, "error");
  if (editingId) {
    const { data, error } = await supabase.from("app_icons").update({ name }).eq("id", editingId).select("id");
    if (error) return setMessage(error.message, "error");
    if (!(data && data.length)) return setMessage("このアイコンが見つかりません(他の画面で消されたかもしれません)。直した内容は保存していません。", "error");
    resetForm();
    return setMessage("直しました。", "ok");
  }
  if (!picked) return setMessage("画像を選んでください。", "error");
  if (icons.length >= ICON_MAX) return setMessage(`アイコンは${ICON_MAX}件までです。`, "error");
  const blobs = [];
  for (const size of SIZES) blobs.push([size, await toBlob(draw(picked, size))]);
  const top = icons.reduce((m, x) => Math.max(m, x.sort_order), 0);
  // 先に行を作って(id が決まる)、画像を入れる。画像が1つでも入らなければ、行も画像も消して、やり直せるようにする
  const made = await supabase.from("app_icons").insert({ name, sort_order: top + 1 }).select("id").single();
  if (made.error) return setMessage(made.error.message, "error");
  const id = made.data.id;
  const done = [];
  for (const [size, blob] of blobs) {
    const up = await supabase.storage.from(BUCKET).upload(`${id}/${size}.png`, blob, { contentType: "image/png" });
    if (up.error) {
      await supabase.from("app_icons").delete().eq("id", id);
      if (done.length) await supabase.storage.from(BUCKET).remove(done);
      return setMessage("画像を入れられませんでした(追加していません)。" + friendlyText(up.error.message), "error", true);
    }
    done.push(`${id}/${size}.png`);
  }
  resetForm();
  setMessage("追加しました。利用者が、カレンダーの設定の一番下で選べます。", "ok");
});

export function initIconsAdmin() {
  resetForm();
  $("icon-save").addEventListener("click", () => save());
  $("icon-file").addEventListener("change", onFile);
  $("icon-cancel").addEventListener("click", () => {
    resetForm();
    setMessage("");
  });
  document.querySelector('.dtab[data-tab="settings"]').addEventListener("click", () => load());
  load();
}
