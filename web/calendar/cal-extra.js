// shiftflowカレンダーの、TODOメモ・重要メモ・画像の置き場・スタンプ。
// 画面の土台(月の画面・パネル)は cal-main.js。ここは env(S・パネルの開閉・Supabase など)を受け取って使う。
// 画像の中身は Supabase Storage の calendar バケット(自分のフォルダ <user_id>/… だけ)。
export const GALLERY_MAX = 10;
export const NOTE_MAX = 10;
const GALLERY_BYTES = 400 * 1024;

// 画像を縮小して Blob にする(長い辺 maxSide まで。向きを直し、描き直すので位置情報は消える)
// 画像を読む。端末によって、createImageBitmap の指定(向きの扱い)や形式(iPhone の HEIC など)が通らないことがあるので、
// ①向きを直して読む → ② <img> で読む(向きはブラウザが直す)の順に試す(L9)。
// 向きの指定なしで createImageBitmap を呼ぶ方法は使わない: 端末によっては向きの情報を無視して、写真が横向きになるため(D6)
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) { /* 次の方法へ */ }
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
const sizeOf = (img) => ({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });

export async function shrinkImage(file, maxSide, type, quality) {
  const img = await decodeImage(file);
  const { w, h } = sizeOf(img);
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext("2d");
  if (type === "image/jpeg") { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  return await new Promise((res) => c.toBlob(res, type, quality));
}
// 「画像」の置き場に入れる画像: 長い辺1400px・約400KB以下
export async function shrinkForGallery(file) {
  let b = await shrinkImage(file, 1400, "image/jpeg", 0.82);
  if (b && b.size > GALLERY_BYTES) b = await shrinkImage(file, 1100, "image/jpeg", 0.7);
  if (b && b.size > GALLERY_BYTES) b = await shrinkImage(file, 900, "image/jpeg", 0.6);
  return b;
}

// 予定に付ける写真: 長い辺1280px・約200KB以下のJPEG(3枚まで・予定の終了日から1か月で消える)
const EVENT_PHOTO_BYTES = 200 * 1024;
export async function shrinkForEvent(file) {
  let b = await shrinkImage(file, 1280, "image/jpeg", 0.8);
  if (b && b.size > EVENT_PHOTO_BYTES) b = await shrinkImage(file, 1024, "image/jpeg", 0.7);
  if (b && b.size > EVENT_PHOTO_BYTES) b = await shrinkImage(file, 800, "image/jpeg", 0.6);
  return b;
}

export function createExtras(env) {
  const { S, $, esc, supabase, openPanel, setPanel, closePanel, head, render, userId } = env;
  // 画像の期限つき URL(1時間)。期限の5分前を過ぎたものは作り直す(開いたままの画面で、画像が出なくならないように。M5)
  const urls = new Map(); // path → { url, exp }
  const SIGN_SECONDS = 3600;
  const freshUrl = (p) => { const u = urls.get(p); return u && u.exp - Date.now() > 5 * 60 * 1000 ? u.url : ""; };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const errText = (e) => env.friendlyText(e && e.message ? e.message : String(e));
  const say = (id, text, ok = false) => { const el = $(id); if (el) { el.textContent = text || ""; el.className = "msg " + (ok ? "ok" : "err"); } };

  // ---------- 画像の URL(非公開なので、期限つきの URL を作って使う) ----------
  async function signed(paths) {
    const need = [...new Set(paths.filter((p) => p && !freshUrl(p)))];
    if (!need.length) return;
    const { data, error } = await supabase.storage.from("calendar").createSignedUrls(need, SIGN_SECONDS);
    if (error) return;
    for (const d of data || []) if (d.signedUrl) urls.set(d.path, { url: d.signedUrl, exp: Date.now() + SIGN_SECONDS * 1000 });
  }
  async function urlFor(path) { await signed([path]); return freshUrl(path); }
  async function hydrate(root) {
    const imgs = [...(root || document).querySelectorAll("img[data-path]")];
    if (!imgs.length) return;
    await signed(imgs.map((i) => i.dataset.path));
    for (const img of imgs) {
      const u = freshUrl(img.dataset.path);
      if (u && img.getAttribute("src") !== u) img.src = u;
    }
  }

  async function upload(path, blob, contentType) {
    const { error } = await supabase.storage.from("calendar").upload(path, blob, { contentType, upsert: false });
    if (error) throw error;
  }
  // ファイルを消す。消せたら true(消せなかったときは、行を消さないよう false を返す。消し忘れの写真を残さないため)
  async function removeFiles(paths) {
    const list = paths.filter(Boolean);
    if (!list.length) return true;
    const { error } = await supabase.storage.from("calendar").remove(list);
    return !error;
  }

  // ---------- 読み込み ----------
  async function load() {
    const [t, i, g, d, s] = await Promise.all([
      supabase.from("cal_todos").select("*").order("sort").order("created_at"),
      supabase.from("cal_importants").select("*").order("sort").order("created_at"),
      supabase.from("cal_gallery").select("*").order("created_at", { ascending: false }),
      supabase.from("cal_stamp_defs").select("*").order("sort").order("created_at"),
      env.selectAllPages((from, to) => supabase.from("cal_stamps").select("*").order("created_at").order("id").range(from, to)),
    ].map((p) => Promise.resolve(p).then((r) => (Array.isArray(r) ? { data: r } : r))));
    for (const r of [t, i, g, d]) if (r.error) throw r.error;
    S.todos = t.data || [];
    S.importants = i.data || [];
    S.gallery = g.data || [];
    S.stampDefs = d.data || [];
    S.stamps = s.data || [];
  }

  // ====================== TODOメモ ======================
  function todoHtml() {
    const open = S.todos.filter((x) => !x.done);
    const done = S.todos.filter((x) => x.done);
    const row = (t) => `<div class="trow${t.done ? " done" : ""}" data-tid="${esc(t.id)}"><input type="checkbox" class="tck" data-act="todo-tick" data-id="${esc(t.id)}"${t.done ? " checked" : ""} aria-label="済み"><input class="tin" data-tin="${esc(t.id)}" maxlength="100" value="${esc(t.text)}" aria-label="内容">${t.done ? `<button class="x" data-act="todo-del" data-id="${esc(t.id)}" aria-label="消す">✕</button>` : ""}</div>`;
    return `${head("TODOメモ")}<div class="pb">${open.map(row).join("")}
      <div class="trow"><button class="btn" data-act="todo-add" aria-label="追加">＋</button><input class="tin" id="td-new" maxlength="100" placeholder="リストアイテム(入力して＋かEnter)" aria-label="新しい内容"></div>
      ${done.length ? `<div class="tdh"><span>済み ${done.length}件</span><button class="btn" data-act="todo-clear">済みをすべて消す</button></div>${done.map(row).join("")}` : ""}
      <p class="msg err" id="x-msg"></p></div>`;
  }
  function openTodo() { openPanel(todoHtml()); }
  async function todoAdd() {
    const input = $("td-new");
    const text = (input.value || "").trim();
    if (!text) return;
    if (S.todos.length >= 200) return say("x-msg", "TODOは200件までです。");
    const sort = S.todos.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
    const { data, error } = await supabase.from("cal_todos").insert({ text, sort }).select().single();
    if (error) return say("x-msg", errText(error));
    S.todos.push(data);
    setPanel(todoHtml());
    $("td-new").focus();
  }

  // ====================== 重要メモ ======================
  function impListHtml() {
    return `${head("重要メモ")}<div class="pb"><button class="btn pri" data-act="imp-new">＋ メモを追加</button>
      ${S.importants.length ? S.importants.map((m) => `<button class="icard" data-act="imp-edit" data-id="${esc(m.id)}"><div class="t">${esc(m.title)}</div><div class="m">${esc(m.body)}</div></button>`).join("") : '<p class="sub">忘れたくないこと(連絡先・保管場所・ゴミの日など)を書いておけます。</p>'}</div>`;
  }
  function openImportant() { openPanel(impListHtml()); }
  let impDraft = null;
  function impForm(id) {
    const m = id ? S.importants.find((x) => x.id === id) : null;
    impDraft = { id: m ? m.id : null };
    setPanel(`${head(m ? "重要メモを編集" : "重要メモを追加")}<div class="pb">
      <div class="fld"><label class="lb" for="im-t">題名</label><input class="in" id="im-t" maxlength="40" value="${esc(m ? m.title : "")}" autocomplete="off"></div>
      <div class="fld"><label class="lb" for="im-b">内容</label><textarea class="in" id="im-b" maxlength="1000" style="min-height:160px">${esc(m ? m.body : "")}</textarea></div>
      <p class="msg err" id="x-msg"></p>
      <div class="btns"><button class="btn pri" data-act="imp-save">保存</button><button class="btn" data-act="imp-back">やめる</button>${m ? '<button class="btn dng" data-act="imp-del">このメモを消す</button>' : ""}</div></div>`);
  }
  async function impSave() {
    const title = $("im-t").value.trim();
    if (!title) return say("x-msg", "題名を入れてください。");
    const body = $("im-b").value;
    if (impDraft.id) {
      const { error } = await supabase.from("cal_importants").update({ title, body }).eq("id", impDraft.id);
      if (error) return say("x-msg", errText(error));
      const m = S.importants.find((x) => x.id === impDraft.id);
      if (m) Object.assign(m, { title, body });
    } else {
      if (S.importants.length >= 100) return say("x-msg", "重要メモは100件までです。");
      const sort = S.importants.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
      const { data, error } = await supabase.from("cal_importants").insert({ title, body, sort }).select().single();
      if (error) return say("x-msg", errText(error));
      S.importants.push(data);
    }
    setPanel(impListHtml());
  }
  async function impDel() {
    if (!window.confirm("このメモを消します。よろしいですか？")) return;
    const { error } = await supabase.from("cal_importants").delete().eq("id", impDraft.id);
    if (error) return say("x-msg", errText(error));
    S.importants = S.importants.filter((x) => x.id !== impDraft.id);
    setPanel(impListHtml());
  }

  // ====================== 画像の置き場 ======================
  function galleryHtml() {
    const full = S.gallery.length >= GALLERY_MAX;
    return `${head(`画像 ${S.gallery.length}/${GALLERY_MAX}`)}<div class="pb">
      <label class="btn pri filebtn${full ? " off" : ""}" style="${full ? "opacity:.4" : ""}">＋ 画像を追加<input type="file" id="gal-file" accept="image/*" multiple${full ? " disabled" : ""}></label>
      <p class="sub">子供の日程表などを置いておけます。1人${GALLERY_MAX}枚までです(自動では消えません)。画像は小さくしてから保存します。</p>
      <p class="msg err" id="x-msg"></p>
      <div class="ggrid">${S.gallery.map((g) => `<div class="gitem" data-gid="${esc(g.id)}"><img data-path="${esc(g.path)}" data-act="gal-view" data-id="${esc(g.id)}" alt="${esc(g.title)}"><div class="gt"><input data-gtitle="${esc(g.id)}" maxlength="40" value="${esc(g.title)}" placeholder="名前" aria-label="名前"><button class="btn" data-act="gal-del" data-id="${esc(g.id)}" aria-label="消す">✕</button></div></div>`).join("")}</div></div>`;
  }
  async function openGallery() {
    openPanel(galleryHtml());
    hydrate($("panel"));
  }
  async function addImages(files) {
    const room = GALLERY_MAX - S.gallery.length;
    const list = [...files].slice(0, Math.max(0, room));
    if (!list.length) return say("x-msg", `画像は${GALLERY_MAX}枚までです。`);
    say("x-msg", "保存しています…", true);
    let skipped = 0;
    for (const f of list) {
      try {
        const blob = await shrinkForGallery(f);
        if (!blob) throw new Error("画像を読み込めませんでした。");
        const path = `${userId}/g-${uuid()}.jpg`;
        await upload(path, blob, "image/jpeg");
        const { data, error } = await supabase.from("cal_gallery").insert({ path, size_bytes: blob.size }).select().single();
        if (error) { await removeFiles([path]); throw error; }
        S.gallery.unshift(data);
      } catch (e) {
        skipped++;
        say("x-msg", errText(e));
      }
    }
    setPanel(galleryHtml());
    hydrate($("panel"));
    if (files.length > list.length) say("x-msg", `${GALLERY_MAX}枚までなので、入りきらなかった分は入れていません。`);
    else if (skipped) say("x-msg", `${skipped}枚は保存できませんでした。`);
  }
  async function galDel(id) {
    const g = S.gallery.find((x) => x.id === id);
    if (!g || !window.confirm("この画像を消します。よろしいですか？")) return;
    const { error } = await supabase.from("cal_gallery").delete().eq("id", id);
    if (error) return say("x-msg", errText(error));
    await removeFiles([g.path]);
    S.gallery = S.gallery.filter((x) => x.id !== id);
    setPanel(galleryHtml());
    hydrate($("panel"));
  }
  async function galView(id) {
    const g = S.gallery.find((x) => x.id === id);
    if (!g) return;
    env.openViewer(await urlFor(g.path), g.title || "");
  }

  // ====================== スタンプ ======================
  const mode = { on: false, def: null };
  let selSid = null;
  const defOf = (id) => S.stampDefs.find((d) => d.id === id);
  const stampOf = (id) => S.stamps.find((s) => s.id === id);
  const txStyle = (d) => `--fgc:${esc(d.text_color)};--bgc:${esc(d.bg_color)}`;
  function defInner(d) {
    if (d.kind === "emoji") return esc(d.emoji);
    if (d.kind === "image") return `<img data-path="${esc(d.image_path)}" alt="">`;
    return `<span class="tx r-${esc(d.shape)}" style="${txStyle(d)}">${esc(d.text)}</span>`;
  }
  function stampEl(st) {
    const d = defOf(st.stamp_def_id);
    if (!d) return "";
    return `<span class="stamp${st.id === selSid ? " sel" : ""}" data-sid="${esc(st.id)}" style="left:${st.x * 100}%;top:${st.y * 100}%;--s:${st.size};--r:${st.rotation}deg">${defInner(d)}</span>`;
  }
  // その週の7日ぶんのスタンプの層
  function stampsLayer(dates) {
    const by = new Map();
    for (const st of S.stamps) { if (!by.has(st.date)) by.set(st.date, []); by.get(st.date).push(st); }
    return `<div class="stl">${dates.map((d) => `<div class="stc">${(by.get(d) || []).map(stampEl).join("")}</div>`).join("")}</div>`;
  }

  function trayHtml() {
    const items = S.stampDefs.map((d) => `<button class="tk${mode.def === d.id ? " on" : ""}" data-act="st-pick" data-id="${esc(d.id)}" aria-label="スタンプ">${defInner(d)}</button>`).join("");
    const msg = !S.stampDefs.length ? '<span class="tmsg">スタンプを作りましょう →</span>' : mode.def ? '<span class="tmsg">置きたい日をタップ(置いたスタンプを動かすときは、選びを外す)</span>' : '<span class="tmsg">スタンプを選ぶ(置いたスタンプは、タップで編集・ドラッグで移動)</span>';
    return `${items}<button class="btn tadd" data-act="df-new">＋ 作る</button><button class="btn tadd" data-act="df-list">管理</button>${msg}<button class="btn tadd" data-act="st-off">閉じる</button>`;
  }
  function renderTray() {
    const t = $("tray");
    t.hidden = !mode.on;
    $("tab-stamp").classList.toggle("on", mode.on);
    $("tab-today").classList.toggle("on", !mode.on); // どちらか1つだけを太字に
    if (mode.on) { t.innerHTML = trayHtml(); hydrate(t); }
  }
  function toggleStampMode(force) {
    mode.on = typeof force === "boolean" ? force : !mode.on;
    if (!mode.on) mode.def = null;
    renderTray();
    render();
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  async function placeStamp(date, pos) {
    const d = defOf(mode.def);
    if (!d) return;
    // タップした場所に置く(マスの中の位置。指定が無いときは真ん中の少し下)
    const x = pos ? clamp(pos.x, 0.12, 0.88) : 0.5;
    const y = pos ? clamp(pos.y, 0.2, 0.88) : 0.58;
    const row = { date, stamp_def_id: d.id, x, y, size: d.default_size, rotation: 0 };
    const { data, error } = await supabase.from("cal_stamps").insert(row).select().single();
    if (error) { env.fail(error); return; }
    S.stamps.push(data);
    mode.def = null;
    renderTray();
    render();
  }

  // 日付のマスをタップしたとき。スタンプの画面なら、ここで受ける(true)
  function cellTap(date, pos) {
    if (!mode.on) return false;
    if (mode.def) placeStamp(date, pos); else toggleStampMode(false);
    return true;
  }

  // ---- スタンプの移動(ドラッグ)・選択(タップ) ----
  let drag = null;
  function cellAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) if (el.classList && el.classList.contains("cell") && el.dataset.date) return el;
    return null;
  }
  function bindDrag() {
    const weeks = $("weeks");
    weeks.addEventListener("pointerdown", (ev) => {
      const el = ev.target.closest(".stamp");
      if (!el) return;
      if (mode.on && mode.def) return; // 置くスタンプを選んでいるあいだは、置いてあるスタンプの上のタップも、そのマスへの配置にする(M4)
      ev.preventDefault();
      drag = { sid: el.dataset.sid, el, x0: ev.clientX, y0: ev.clientY, moved: false, ghost: null, over: null, id: ev.pointerId };
      try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 取れなくても動く */ }
    });
    weeks.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) > 6) {
        drag.moved = true;
        const g = drag.el.cloneNode(true);
        g.classList.add("ghost");
        g.style.width = drag.el.getBoundingClientRect().width + "px";
        g.style.fontSize = getComputedStyle(drag.el).fontSize;
        g.style.removeProperty("left"); g.style.removeProperty("top");
        document.body.appendChild(g);
        drag.ghost = g;
        drag.el.style.opacity = ".25";
      }
      if (drag.moved) {
        drag.ghost.style.left = ev.clientX + "px";
        drag.ghost.style.top = ev.clientY + "px";
        const c = cellAt(ev.clientX, ev.clientY);
        if (drag.over !== c) { if (drag.over) drag.over.classList.remove("drop"); if (c) c.classList.add("drop"); drag.over = c; }
      }
    });
    const end = async (ev, cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.ghost) d.ghost.remove();
      if (d.over) d.over.classList.remove("drop");
      d.el.style.opacity = "";
      if (!d.moved) { if (!cancelled) openStampEdit(d.sid); return; }
      const cell = cancelled ? null : cellAt(ev.clientX, ev.clientY);
      const st = stampOf(d.sid);
      if (!cell || !st) return;
      const r = cell.getBoundingClientRect();
      const x = Math.min(1.4, Math.max(-0.4, (ev.clientX - r.left) / r.width));
      const y = Math.min(1.4, Math.max(-0.4, (ev.clientY - r.top) / r.height));
      const prev = { date: st.date, x: st.x, y: st.y };
      Object.assign(st, { date: cell.dataset.date, x, y });
      render();
      const { error } = await supabase.from("cal_stamps").update({ date: st.date, x, y }).eq("id", st.id);
      if (error) { Object.assign(st, prev); render(); env.fail(error); }
    };
    weeks.addEventListener("pointerup", (ev) => end(ev, false));
    weeks.addEventListener("pointercancel", (ev) => end(ev, true));
  }

  // ---- スタンプを選んだときの編集(大きさ・回転・削除・メモ) ----
  let noteDraft = null; // {index|-1, t, d}
  function stampEditHtml(st, msg = "") {
    const d = defOf(st.stamp_def_id);
    const notes = st.notes || [];
    const form = noteDraft
      ? `<div class="card"><div class="fld"><label class="lb" for="sn-t">題名</label><input class="in" id="sn-t" maxlength="40" value="${esc(noteDraft.t)}"></div><div class="fld"><label class="lb" for="sn-d">詳細(なくてもよい)</label><textarea class="in" id="sn-d" maxlength="300" style="min-height:70px">${esc(noteDraft.d)}</textarea></div><div class="btns"><button class="btn pri" data-act="sn-save">保存</button><button class="btn" data-act="sn-cancel">やめる</button>${noteDraft.index >= 0 ? '<button class="btn dng" data-act="sn-del">消す</button>' : ""}</div></div>`
      : `<div class="btns"><button class="btn" data-act="sn-new"${notes.length >= NOTE_MAX ? " disabled" : ""}>＋ 予定を追加</button></div>`;
    return `${head("スタンプ")}<div class="pb">
      <div class="fld"><label class="lb" for="st-size">大きさ</label><input class="slider" type="range" id="st-size" data-st="size" min="0.12" max="2" step="0.01" value="${st.size}"></div>
      <div class="fld"><label class="lb" for="st-rot">回転</label><input class="slider" type="range" id="st-rot" data-st="rotation" min="-180" max="180" step="1" value="${st.rotation}"></div>
      <p class="sub">${d ? "" : "このスタンプの種類は消されています。"}メモは、カレンダーの予定の一覧には出ません。このスタンプを選んだときだけ出ます。</p>
      <div>${notes.map((n, i) => `<button class="chipnote" data-act="sn-edit" data-i="${i}">${esc(n.t)}${n.d ? `<small>${esc(n.d)}</small>` : ""}</button>`).join("")}</div>
      ${form}
      <p class="msg err" id="x-msg">${esc(msg)}</p>
      <div class="btns"><button class="btn dng" data-act="st-del">スタンプを消す</button><button class="btn" data-act="close">閉じる</button></div></div>`;
  }
  function openStampEdit(sid) {
    const st = stampOf(sid);
    if (!st) return;
    selSid = sid;
    noteDraft = null;
    openPanel(stampEditHtml(st), { onClose: () => { selSid = null; noteDraft = null; render(); } });
    render();
  }
  function liveStamp(st) {
    const el = document.querySelector(`.stamp[data-sid="${CSS.escape(st.id)}"]`);
    if (el) { el.style.setProperty("--s", st.size); el.style.setProperty("--r", st.rotation + "deg"); }
  }
  async function saveStampFields(st) {
    const { error } = await supabase.from("cal_stamps").update({ size: st.size, rotation: st.rotation }).eq("id", st.id);
    if (error) say("x-msg", errText(error));
  }
  async function saveNotes(st, notes) {
    const { error } = await supabase.from("cal_stamps").update({ notes }).eq("id", st.id);
    if (error) { setPanel(stampEditHtml(st, errText(error))); return false; }
    st.notes = notes;
    return true;
  }
  async function stampAction(act, el) {
    const st = stampOf(selSid);
    if (!st) return;
    if (act === "st-del") {
      if (!window.confirm("このスタンプを消します(メモも消えます)。よろしいですか？")) return;
      const { error } = await supabase.from("cal_stamps").delete().eq("id", st.id);
      if (error) return say("x-msg", errText(error));
      S.stamps = S.stamps.filter((x) => x.id !== st.id);
      selSid = null;
      closePanel();
      render();
    } else if (act === "sn-new") { noteDraft = { index: -1, t: "", d: "" }; setPanel(stampEditHtml(st)); }
    else if (act === "sn-edit") { const i = Number(el.dataset.i); const n = (st.notes || [])[i]; noteDraft = { index: i, t: n.t, d: n.d || "" }; setPanel(stampEditHtml(st)); }
    else if (act === "sn-cancel") { noteDraft = null; setPanel(stampEditHtml(st)); }
    else if (act === "sn-save") {
      const t = $("sn-t").value.trim();
      if (!t) return say("x-msg", "題名を入れてください。");
      const notes = (st.notes || []).slice();
      const n = { t, d: $("sn-d").value.trim() };
      if (noteDraft.index >= 0) notes[noteDraft.index] = n; else notes.push(n);
      if (notes.length > NOTE_MAX) return say("x-msg", `メモは${NOTE_MAX}件までです。`);
      if (await saveNotes(st, notes)) { noteDraft = null; setPanel(stampEditHtml(st)); }
    } else if (act === "sn-del") {
      const notes = (st.notes || []).filter((_, i) => i !== noteDraft.index);
      if (await saveNotes(st, notes)) { noteDraft = null; setPanel(stampEditHtml(st)); }
    }
  }

  // ---- スタンプの種類(作る・直す・並べ替え・消す) ----
  function defPreview(d) { return `<span class="tk" style="display:inline-flex;width:52px;height:52px;border:1px solid var(--line);border-radius:10px;align-items:center;justify-content:center;font-size:30px">${defInner(d)}</span>`; }
  function defListHtml(msg = "") {
    const rows = S.stampDefs.map((d, i) => `<div class="lrow" data-did="${esc(d.id)}">${defPreview(d)}<span class="in" style="border:0;flex:1"></span>
      <button class="btn sm" data-act="df-up" data-id="${esc(d.id)}"${i === 0 ? " disabled" : ""} aria-label="前へ">↑</button><button class="btn sm" data-act="df-down" data-id="${esc(d.id)}"${i === S.stampDefs.length - 1 ? " disabled" : ""} aria-label="後ろへ">↓</button>
      <button class="btn sm" data-act="df-edit" data-id="${esc(d.id)}">直す</button><button class="btn sm dng" data-act="df-del" data-id="${esc(d.id)}" aria-label="消す">✕</button></div>`).join("");
    return `${head("スタンプの種類")}<div class="pb"><button class="btn pri" data-act="df-new">＋ スタンプを作る</button>${rows || '<p class="sub">まだありません。</p>'}<p class="msg err" id="x-msg">${esc(msg)}</p></div>`;
  }
  let dd = null; // 作る・直すスタンプの下書き
  function defFormHtml(msg = "") {
    const kinds = [["emoji", "絵文字"], ["text", "文字"], ["image", "画像"]];
    const prev = dd.kind === "image" ? (dd.blobUrl ? `<img src="${esc(dd.blobUrl)}" alt="">` : dd.image_path ? `<img data-path="${esc(dd.image_path)}" alt="">` : "") : defInner(dd);
    return `${head(dd.id ? "スタンプを直す" : "スタンプを作る")}<div class="pb">
      <div class="seg" role="radiogroup">${kinds.map(([v, t]) => `<label><input type="radio" name="dkind" value="${v}" data-df="kind"${dd.kind === v ? " checked" : ""}><span>${t}</span></label>`).join("")}</div>
      <p style="text-align:center"><span class="tk" id="d-prev" style="display:inline-flex;min-width:72px;height:72px;border:1px solid var(--line);border-radius:12px;align-items:center;justify-content:center;font-size:40px;margin:12px 0">${prev}</span></p>
      ${dd.kind === "emoji" ? `<div class="fld"><label class="lb" for="d-emoji">絵文字</label><input class="in" id="d-emoji" data-df="emoji" maxlength="8" value="${esc(dd.emoji)}"></div>` : ""}
      ${dd.kind === "text" ? `<div class="fld"><label class="lb" for="d-text">文字(8文字まで)</label><input class="in" id="d-text" data-df="text" maxlength="8" value="${esc(dd.text)}"></div>
        <div class="row2"><div class="fld"><label class="lb" for="d-fg">文字の色</label><input type="color" id="d-fg" data-df="text_color" value="${esc(dd.text_color)}"></div><div class="fld"><label class="lb" for="d-bg">背景の色</label><input type="color" id="d-bg" data-df="bg_color" value="${esc(dd.bg_color)}"></div></div>
        <div class="fld"><label class="lb" for="d-shape">形</label><select class="in" id="d-shape" data-df="shape">${[["round", "丸"], ["square", "角"], ["bubble", "吹き出し"]].map(([v, t]) => `<option value="${v}"${dd.shape === v ? " selected" : ""}>${t}</option>`).join("")}</select></div>` : ""}
      ${dd.kind === "image" ? `<div class="fld"><label class="btn filebtn">画像を選ぶ<input type="file" id="d-file" accept="image/*"></label><p class="sub">256px くらいに小さくして保存します(透明な部分は残ります)。</p></div>` : ""}
      <div class="fld"><label class="lb" for="d-size">標準の大きさ</label><input class="slider" type="range" id="d-size" data-df="default_size" min="0.12" max="2" step="0.01" value="${dd.default_size}"></div>
      <p class="msg err" id="x-msg">${esc(msg)}</p>
      <div class="btns"><button class="btn pri" data-act="df-save">保存</button><button class="btn" data-act="df-back">やめる</button></div></div>`;
  }
  function openDefForm(id) {
    const d = id ? defOf(id) : null;
    dd = d ? { ...d, blob: null, blobUrl: "" } : { id: null, kind: "emoji", emoji: "🙂", image_path: "", text: "", text_color: "#ffffff", bg_color: "#5b4bd6", shape: "round", default_size: 0.34, blob: null, blobUrl: "" };
    openPanel(defFormHtml());
    hydrate($("panel"));
  }
  function refreshDefPreview() {
    const p = $("d-prev");
    if (!p) return;
    p.innerHTML = dd.kind === "image" ? (dd.blobUrl ? `<img src="${esc(dd.blobUrl)}" alt="">` : dd.image_path ? `<img data-path="${esc(dd.image_path)}" alt="">` : "") : defInner(dd);
    hydrate(p);
  }
  async function saveDef() {
    const row = { kind: dd.kind, emoji: dd.kind === "emoji" ? dd.emoji.trim() : "", text: dd.kind === "text" ? dd.text.trim() : "", text_color: dd.text_color, bg_color: dd.bg_color, shape: dd.shape, default_size: Number(dd.default_size) };
    if (dd.kind === "emoji" && !row.emoji) return say("x-msg", "絵文字を入れてください。");
    if (dd.kind === "text" && !row.text) return say("x-msg", "文字を入れてください。");
    if (dd.kind === "image" && !dd.blob && !dd.image_path) return say("x-msg", "画像を選んでください。");
    say("x-msg", "保存しています…", true);
    let newPath = "";
    const oldPath = dd.id ? (defOf(dd.id) || {}).image_path : "";
    try {
      if (dd.kind === "image") {
        if (dd.blob) { newPath = `${userId}/s-${uuid()}.png`; await upload(newPath, dd.blob, "image/png"); row.image_path = newPath; }
        else row.image_path = dd.image_path;
      } else row.image_path = "";
      if (dd.id) {
        const { data, error } = await supabase.from("cal_stamp_defs").update(row).eq("id", dd.id).select().single();
        if (error) throw error;
        Object.assign(defOf(dd.id), data);
      } else {
        row.sort = S.stampDefs.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
        const { data, error } = await supabase.from("cal_stamp_defs").insert(row).select().single();
        if (error) throw error;
        S.stampDefs.push(data);
      }
      if (oldPath && oldPath !== row.image_path) await removeFiles([oldPath]);
      setPanel(defListHtml());
      hydrate($("panel"));
      renderTray();
      render();
    } catch (e) {
      if (newPath) await removeFiles([newPath]);
      say("x-msg", errText(e));
    }
  }
  async function moveDef(id, delta) {
    const i = S.stampDefs.findIndex((d) => d.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= S.stampDefs.length) return;
    const order = S.stampDefs.slice();
    [order[i], order[j]] = [order[j], order[i]];
    for (let k = 0; k < order.length; k++) if (order[k].sort !== k + 1) {
      const { error } = await supabase.from("cal_stamp_defs").update({ sort: k + 1 }).eq("id", order[k].id);
      if (error) return say("x-msg", errText(error));
      order[k].sort = k + 1;
    }
    S.stampDefs = order;
    setPanel(defListHtml());
    hydrate($("panel"));
    renderTray();
  }
  async function delDef(id) {
    const d = defOf(id);
    if (!d || !window.confirm("このスタンプの種類を消します。置いてあるこのスタンプも消えます。よろしいですか？")) return;
    const { error } = await supabase.from("cal_stamp_defs").delete().eq("id", id);
    if (error) return say("x-msg", errText(error));
    S.stampDefs = S.stampDefs.filter((x) => x.id !== id);
    S.stamps = S.stamps.filter((s) => s.stamp_def_id !== id);
    if (mode.def === id) mode.def = null;
    if (d.image_path) await removeFiles([d.image_path]);
    setPanel(defListHtml());
    hydrate($("panel"));
    renderTray();
    render();
  }

  // ====================== パネルの操作の受け口 ======================
  async function panelClick(el, act) {
    try {
      switch (act) {
        case "todo-add": await todoAdd(); return true;
        case "todo-tick": {
          const t = S.todos.find((x) => x.id === el.dataset.id);
          if (!t) return true;
          const done = el.checked;
          const { error } = await supabase.from("cal_todos").update({ done }).eq("id", t.id);
          if (error) { el.checked = !done; say("x-msg", errText(error)); return true; }
          t.done = done;
          setPanel(todoHtml());
          return true;
        }
        case "todo-del": {
          const { error } = await supabase.from("cal_todos").delete().eq("id", el.dataset.id);
          if (error) return say("x-msg", errText(error)), true;
          S.todos = S.todos.filter((x) => x.id !== el.dataset.id);
          setPanel(todoHtml());
          return true;
        }
        case "todo-clear": {
          if (!window.confirm("済みのメモをすべて消します。よろしいですか？")) return true;
          const { error } = await supabase.from("cal_todos").delete().eq("done", true);
          if (error) return say("x-msg", errText(error)), true;
          S.todos = S.todos.filter((x) => !x.done);
          setPanel(todoHtml());
          return true;
        }
        case "imp-new": impForm(null); return true;
        case "imp-edit": impForm(el.dataset.id); return true;
        case "imp-save": await impSave(); return true;
        case "imp-back": setPanel(impListHtml()); return true;
        case "imp-del": await impDel(); return true;
        case "gal-del": await galDel(el.dataset.id); return true;
        case "gal-view": galView(el.dataset.id); return true;
        case "st-pick": mode.def = mode.def === el.dataset.id ? null : el.dataset.id; renderTray(); return true;
        case "st-off": toggleStampMode(false); return true;
        case "df-list": openPanel(defListHtml()); hydrate($("panel")); return true;
        case "df-new": openDefForm(null); return true;
        case "df-edit": openDefForm(el.dataset.id); return true;
        case "df-save": await saveDef(); return true;
        case "df-back": setPanel(defListHtml()); hydrate($("panel")); return true;
        case "df-up": await moveDef(el.dataset.id, -1); return true;
        case "df-down": await moveDef(el.dataset.id, 1); return true;
        case "df-del": await delDef(el.dataset.id); return true;
        case "st-del": case "sn-new": case "sn-edit": case "sn-cancel": case "sn-save": case "sn-del": await stampAction(act, el); return true;
        default: return false;
      }
    } catch (e) {
      say("x-msg", errText(e));
      return true;
    }
  }
  // トレーはパネルの外にあるので、別に受ける
  function trayClick(ev) {
    const el = ev.target.closest("[data-act]");
    if (el) panelClick(el, el.dataset.act);
  }
  // 入力・変更: true なら受けた
  async function panelChange(el) {
    try {
      if (el.id === "gal-file") { await addImages(el.files); el.value = ""; return true; }
      if (el.dataset.tin) {
        const t = S.todos.find((x) => x.id === el.dataset.tin);
        const text = el.value.trim();
        if (!t) return true;
        if (!text) { el.value = t.text; return true; }
        if (text !== t.text) { const { error } = await supabase.from("cal_todos").update({ text }).eq("id", t.id); if (error) say("x-msg", errText(error)); else t.text = text; }
        return true;
      }
      if (el.dataset.gtitle) {
        const g = S.gallery.find((x) => x.id === el.dataset.gtitle);
        if (g && el.value !== g.title) { const { error } = await supabase.from("cal_gallery").update({ title: el.value.trim() }).eq("id", g.id); if (error) say("x-msg", errText(error)); else g.title = el.value.trim(); }
        return true;
      }
      if (el.dataset.st) {
        const st = stampOf(selSid);
        if (st) { st[el.dataset.st] = Number(el.value); liveStamp(st); await saveStampFields(st); }
        return true;
      }
      if (el.dataset.df) {
        if (!dd) return true;
        dd[el.dataset.df] = el.type === "range" ? Number(el.value) : el.value;
        if (el.dataset.df === "kind") { setPanel(defFormHtml()); hydrate($("panel")); } else refreshDefPreview();
        return true;
      }
      if (el.id === "d-file") {
        const f = el.files && el.files[0];
        if (f) {
          const blob = await shrinkImage(f, 256, "image/png");
          if (blob) { if (dd.blobUrl) URL.revokeObjectURL(dd.blobUrl); dd.blob = blob; dd.blobUrl = URL.createObjectURL(blob); refreshDefPreview(); }
        }
        return true;
      }
    } catch (e) { say("x-msg", errText(e)); return true; }
    return false;
  }
  // 入力中(スライダーを動かしている間・文字): 保存せず、見た目だけ変える
  function panelInput(el) {
    if (el.dataset.st) { const st = stampOf(selSid); if (st) { st[el.dataset.st] = Number(el.value); liveStamp(st); } return true; }
    if (el.dataset.df && dd && el.dataset.df !== "kind") { dd[el.dataset.df] = el.type === "range" ? Number(el.value) : el.value; refreshDefPreview(); return true; }
    return false;
  }
  function panelKey(ev) {
    // 日本語入力の変換を確定する Enter(isComposing・keyCode 229。Safari は確定のあとに keyCode 229 の keydown が来る)では、追加しない(M2)
    if (ev.isComposing || ev.keyCode === 229) return false;
    if (ev.key === "Enter" && ev.target.id === "td-new") { ev.preventDefault(); todoAdd().catch((e) => say("x-msg", errText(e))); return true; }
    return false;
  }

  return {
    upload, removeFiles, uuid,
    load, hydrate, stampsLayer, cellTap, bindDrag, trayClick, renderTray,
    openTodo, openImportant, openGallery, toggleStampMode,
    panelClick, panelChange, panelInput, panelKey,
    stampMode: () => mode.on,
    hasPick: () => !!mode.def,
    cellAt,
    urlFor,
  };
}
