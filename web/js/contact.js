// お問い合わせ。ログイン前でも使える。
//   ログイン前: 社員番号・名前・所属を手で入れる。返事は「受付番号+確認コード」か「メール」
//   ログイン後: 社員番号・名前・所属は表示だけ(送るときはサーバーが DB から取る)。返事は「これまでのお問い合わせ」か「メールでも」
// 予想されるバグの番号(C1 など)は docs/contact/DESIGN.md。
import {
  friendlyText, $, callFunction, configured, currentSession, loadProfile, loadSettings, newRequestKey, renderTopbar, supabase, toHalfWidth,
} from "./app.js?v=dev";
import { CONTACT_EMAIL } from "./config.js?v=dev";

const MAX_BODY = 1000;
const MAX_IMAGES = 3;
const DRAFT_KEY = "shiftflow-contact-draft";
const KIND_LABELS = { login: "ログインできない", howto: "使い方・質問", bug: "不具合", other: "その他" };
const STATUS_LABELS = { open: "受付済み", replied: "返信あり", done: "完了" };
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let mode = "guest"; // "guest" | "member"
let requestKey = "";
let code = ""; // ログイン前で「画面で見る」のときの確認コード(画面で作り、送り直しても同じものを使う)
let images = []; // { id, name, base64, url, before, after }
let preparing = 0; // 準備中の画像の数(I10)
let sending = false;
let pendingOffice = ""; // 下書きの所属(区所の一覧がまだ読めていなくても、読めたら選び直す)

function setMessage(id, text, kind) {
  $(id).textContent = friendlyText(text) || "";
  $(id).className = "message" + (kind ? " " + kind : "");
}

const chars = (s) => [...String(s || "")].length;

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join("");
}

// 全角を半角にし、空白を除き、小文字にする(サーバーと同じ。C8)
function normalizeEmail(v) {
  const s = String(v || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (!s || s.length > 254 || !/^[^@]+@[^@.][^@]*\.[^@.]+$/.test(s) || /[<>()[\]\\,;:"]/.test(s)) return null;
  return s;
}

function riskyEmail(email) {
  const local = (email || "").split("@")[0] || "";
  return local.includes("..") || local.startsWith(".") || local.endsWith(".");
}

function replyVia() {
  return document.querySelector('input[name="reply-via"]:checked')?.value || "screen";
}

// ---------- 下書き(ログインが切れたとき・読み直したときに、書いた内容を消さない。C3) ----------

function saveDraft() {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      mode, requestKey, code, kind: $("kind").value, body: $("body").value, replyVia: replyVia(),
      email: $("email").value, email2: $("email2").value,
      employeeNo: $("employee-no").value, name: $("name").value, office: $("office").value,
    }));
  } catch (_) { /* 保存できない端末では何もしない */ }
}

function loadDraft() {
  try {
    return JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) || "null");
  } catch (_) {
    return null;
  }
}

function clearDraft() {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch (_) { /* 何もしない */ }
}

function applyDraft(d) {
  if (!d) return;
  // 同じ送り方(ログイン前・後)の下書きのときだけ、前のキーとコードを使う(送り直しで同じ受付番号になるように)
  if (d.mode === mode && /^[0-9a-f-]{36}$/i.test(d.requestKey || "")) requestKey = d.requestKey;
  if (d.mode === mode && /^[A-Z2-9]{8}$/.test(d.code || "")) code = d.code;
  if (KIND_LABELS[d.kind]) $("kind").value = d.kind;
  $("body").value = String(d.body || "").slice(0, MAX_BODY);
  const radio = document.querySelector(`input[name="reply-via"][value="${d.replyVia === "mail" ? "mail" : "screen"}"]`);
  if (radio) radio.checked = true;
  $("email").value = d.email || "";
  $("email2").value = d.email2 || "";
  if (mode === "guest") {
    $("employee-no").value = toHalfWidth(d.employeeNo || "").replace(/\D/g, "").slice(0, 7);
    $("name").value = d.name || "";
    pendingOffice = d.office || "";
    if ([...$("office").options].some((o) => o.value === pendingOffice)) $("office").value = pendingOffice;
  }
}

function startNew() {
  requestKey = newRequestKey();
  code = randomCode();
}

// ---------- 画像 ----------

// 画像を読む。createImageBitmap(向きの情報を反映)→ 読めなければ <img> で読み直す(I1・I2)
async function decodeImage(file) {
  if (window.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close && bmp.close() };
    } catch (_) { /* <img> で読み直す */ }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));
}

// 長い辺 1600px の JPEG に描き直す(描き直すので、撮った場所などの情報は消える。I3)。約500KB 以下を目安に画質を下げる(I4)
async function shrinkImage(file) {
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("size");
    for (const [maxSide, quality] of [[1600, 0.82], [1600, 0.7], [1280, 0.7], [1024, 0.6]]) {
      const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // 透明な部分(PNG)が黒くならないように
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas, quality);
      if (!blob) throw new Error("toBlob");
      if (blob.size <= 600_000 || maxSide === 1024) {
        if (blob.size > 1_400_000) throw new Error("too large");
        return blob;
      }
    }
    throw new Error("unreachable");
  } finally {
    decoded.done();
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const kb = (n) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1000)) + "KB");

function renderThumbs() {
  const box = $("thumbs");
  box.querySelectorAll(".thumb").forEach((el) => el.remove());
  images.forEach((img) => {
    const div = document.createElement("div");
    div.className = "thumb";
    const pic = document.createElement("img");
    pic.src = img.url;
    pic.alt = img.name;
    const size = document.createElement("span");
    size.className = "thumb-size";
    size.textContent = `${kb(img.before)}→${kb(img.after)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "thumb-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "この画像を外す");
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(img.url);
      images = images.filter((x) => x !== img);
      renderThumbs();
    });
    div.append(pic, size, remove);
    box.insertBefore(div, $("add-image"));
  });
  $("add-image").classList.toggle("hidden", images.length + preparing >= MAX_IMAGES);
  updateSubmit();
}

async function addFiles(files) {
  setMessage("image-message", "");
  const failed = [];
  for (const file of files) {
    if (images.length + preparing >= MAX_IMAGES) {
      setMessage("image-message", `画像は${MAX_IMAGES}枚までです。`, "error");
      break;
    }
    const id = `${file.name}:${file.size}:${file.lastModified}`;
    if (images.some((x) => x.id === id)) continue; // 同じ画像を2回選んだ(I11)
    preparing++;
    renderThumbs();
    setMessage("image-message", "画像を準備しています…");
    try {
      const blob = await shrinkImage(file);
      images.push({ id, name: file.name, base64: await blobToBase64(blob), url: URL.createObjectURL(blob), before: file.size, after: blob.size });
    } catch (_) {
      failed.push(file.name || "画像");
    } finally {
      preparing--;
      renderThumbs();
    }
  }
  if (failed.length) {
    setMessage("image-message", `この画像は使えません: ${failed.join("、")}。スクリーンショットにして付けてください(iPhoneは「写真ライブラリ」から選んでください)。`, "error");
  } else if ($("image-message").textContent === "画像を準備しています…") {
    setMessage("image-message", "");
  }
}

$("add-image").addEventListener("click", () => $("image-input").click());
$("image-input").addEventListener("change", async () => {
  const files = [...($("image-input").files || [])];
  $("image-input").value = ""; // 外したあとに同じ画像を選び直せるように
  await addFiles(files);
});

// ---------- 入力の確かめ ----------

function problem() {
  if (mode === "guest") {
    if (!/^\d{7}$/.test(toHalfWidth($("employee-no").value))) return "社員番号は7桁の数字で入力してください。";
    if (!$("name").value.trim()) return "名前を入力してください。";
    if (chars($("name").value.trim()) > 40) return "名前は40文字以内にしてください。";
    if (!$("office").value) return "所属を選んでください(わからないときは「わからない」)。";
  }
  if (!$("kind").value) return "種類を選んでください。";
  if (!$("body").value.trim()) return "内容を入力してください。";
  if (chars($("body").value.trim()) > MAX_BODY) return `内容は${MAX_BODY}文字以内にしてください。`;
  if (replyVia() === "mail") {
    const email = normalizeEmail($("email").value);
    if (!email) return "メールアドレスの形が正しくありません。";
    if (normalizeEmail($("email2").value) !== email) return "メールアドレスが2回で一致しません。";
  }
  if (preparing) return "画像を準備しています。少し待ってください。";
  return "";
}

function updateSubmit() {
  $("submit").disabled = sending || preparing > 0;
}

function updateEmailFields() {
  const mail = replyVia() === "mail";
  $("email-fields").classList.toggle("hidden", !mail);
  const email = normalizeEmail($("email").value);
  $("email-risky").classList.toggle("hidden", !(mail && email && riskyEmail(email)));
}

function updateCount() {
  const n = chars($("body").value);
  $("body-count").textContent = n;
  $("body-count").parentElement.classList.toggle("error", n > MAX_BODY);
}

$("contact-form").addEventListener("input", () => {
  updateEmailFields();
  updateCount();
  saveDraft();
});
$("contact-form").addEventListener("change", () => {
  updateEmailFields();
  saveDraft();
});

// ---------- 送信 ----------

$("contact-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (sending) return;
  const p = problem();
  if (p) return setMessage("message", p, "error");
  sending = true;
  updateSubmit();
  setMessage("message", images.length ? "送信しています(画像があるので、少し時間がかかります)…" : "送信しています…");
  const via = replyVia();
  const payload = {
    action: "submit",
    mode,
    request_key: requestKey,
    kind: $("kind").value,
    body: $("body").value.trim(),
    reply_via: via,
    images: images.map((img) => ({ data: img.base64 })),
  };
  if (via === "mail") {
    payload.email = $("email").value;
    payload.email2 = $("email2").value;
  }
  if (mode === "guest") {
    payload.employee_no = toHalfWidth($("employee-no").value);
    payload.name = $("name").value.trim();
    payload.office = $("office").value;
    if (via === "screen") payload.code = code;
  }
  try {
    const res = await callFunction("contact", payload, { stayOnLoss: true, timeoutMs: 60000 });
    showSent(res, via, via === "mail" ? normalizeEmail($("email").value) : null);
  } catch (err) {
    if (err.code === "unauthenticated" || err.code === "not_member") {
      setMessage("message", "ログインが切れました。書いた内容は残してあります。ログインし直してから、もう一度送ってください。", "error");
    } else {
      setMessage("message", err.message || String(err), "error");
    }
  } finally {
    sending = false;
    updateSubmit();
  }
});

function showSent(res, via, email) {
  $("sent-no").textContent = res.no;
  $("sent-code").classList.toggle("hidden", !(mode === "guest" && via === "screen"));
  $("sent-mail").classList.toggle("hidden", via !== "mail");
  $("sent-member").classList.toggle("hidden", mode !== "member" || via === "mail");
  if (mode === "guest" && via === "screen") {
    $("sent-code-no").textContent = res.no;
    $("sent-code-value").textContent = code.slice(0, 4) + "-" + code.slice(4);
    $("view-no").value = res.no;
    $("view-code").value = code.slice(0, 4) + "-" + code.slice(4);
  }
  if (via === "mail") $("sent-email").textContent = email || "";
  if (res.images === "failed") {
    setMessage("sent-images", "画像は届かなかった可能性があります。必要なら、受付番号を書いて、もう一度画像を付けて送ってください。", "error");
  } else if (res.images === "ok") {
    setMessage("sent-images", "画像も届きました。", "ok");
  } else {
    setMessage("sent-images", "");
  }
  $("contact-form").classList.add("hidden");
  $("sent").classList.remove("hidden");
  $("sent").scrollIntoView({ block: "start" });
  clearDraft();
  images.forEach((img) => URL.revokeObjectURL(img.url));
  images = [];
  if (mode === "member") loadMine();
}

$("again").addEventListener("click", () => {
  startNew();
  $("kind").value = "";
  $("body").value = "";
  updateCount();
  renderThumbs();
  setMessage("message", "");
  setMessage("image-message", "");
  $("sent").classList.add("hidden");
  $("contact-form").classList.remove("hidden");
  $("contact-form").scrollIntoView({ block: "start" });
});

// ---------- やり取りの表示 ----------

function formatAt(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function thread(inq) {
  const card = document.createElement("div");
  card.className = "card inquiry";
  const head = document.createElement("div");
  head.className = "inquiry-head";
  const status = document.createElement("span");
  const hasReply = inq.messages.some((m) => m.from === "admin");
  status.className = "status-badge " + (hasReply ? "replied" : inq.status);
  status.textContent = hasReply ? "返信あり" : STATUS_LABELS[inq.status] || inq.status;
  const meta = document.createElement("span");
  meta.className = "muted small";
  meta.textContent = `${inq.no} ・ ${formatAt(inq.created_at)} ・ ${inq.kind}`;
  head.append(status, meta);
  card.appendChild(head);
  inq.messages.forEach((m) => {
    const b = document.createElement("div");
    b.className = "bubble " + (m.from === "admin" ? "from-admin" : "from-user");
    const who = document.createElement("div");
    who.className = "bubble-who";
    who.textContent = (m.from === "admin" ? "管理者からの返事" : "あなた") + " ・ " + formatAt(m.at);
    const text = document.createElement("div");
    text.className = "bubble-text";
    text.textContent = m.body;
    b.append(who, text);
    card.appendChild(b);
  });
  if (!hasReply) {
    const wait = document.createElement("p");
    wait.className = "muted small";
    wait.textContent = inq.reply_via === "mail" ? "返事はメールでも届きます。まだ返事はありません。" : "まだ返事はありません。";
    card.appendChild(wait);
  }
  return card;
}

async function loadMine() {
  setMessage("mine-message", "読み込んでいます…");
  try {
    const res = await callFunction("contact", { action: "mine" }, { stayOnLoss: true });
    const box = $("mine");
    box.innerHTML = "";
    res.inquiries.forEach((inq) => box.appendChild(thread(inq)));
    setMessage("mine-message", res.inquiries.length ? "" : "まだお問い合わせはありません。");
  } catch (err) {
    setMessage("mine-message", "読み込めませんでした: " + (err.message || String(err)), "error");
  }
}

$("view-button").addEventListener("click", async () => {
  const no = $("view-no").value.trim();
  const c = $("view-code").value.trim();
  $("view-result").innerHTML = "";
  if (!no || !c) return setMessage("view-message", "受付番号と確認コードを入れてください。", "error");
  $("view-button").disabled = true;
  setMessage("view-message", "読み込んでいます…");
  try {
    const inq = await callFunction("contact", { action: "view", no, code: c }, { stayOnLoss: true });
    setMessage("view-message", "");
    $("view-result").appendChild(thread(inq));
  } catch (err) {
    setMessage("view-message", err.message || String(err), "error");
  } finally {
    $("view-button").disabled = false;
  }
});

// ---------- はじめ ----------

// 所属の選択肢。区所の一覧を読む前でも「わからない」で送れるように、先に最小の選択肢を作る(I・C14)
function setOfficeOptions(names) {
  const select = $("office");
  const keep = select.value || pendingOffice;
  select.innerHTML = "";
  [["", "選んでください"], ...names.map((n) => [n, n]), ["わからない", "わからない"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
}

// 区所の一覧を読む(6秒で諦める)。読めなくても、フォームは先に出してある
async function loadOffices() {
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ data: null, error: new Error("timeout") }), 6000));
  try {
    const { data, error } = await Promise.race([supabase.rpc("contact_offices"), timeout]);
    if (!error && Array.isArray(data)) setOfficeOptions(data.filter((n) => typeof n === "string"));
  } catch (_) { /* 読めなくても「わからない」で送れる */ }
}

async function memberOfficeName(session) {
  const settings = await loadSettings(session).catch(() => null);
  if (!settings || !settings.office_id) return "未設定";
  const { data } = await supabase.from("offices").select("name").eq("id", settings.office_id).maybeSingle();
  return data?.name || "未設定";
}

async function main() {
  let session = null;
  let profile = null;
  try {
    session = await currentSession();
    if (session) profile = await loadProfile(session);
  } catch (_) { /* 読めなければログイン前として扱う */ }
  const isAdmin = !!(profile && profile.role === "admin");
  renderTopbar("contact.html", { loggedIn: !!profile, isAdmin });
  document.querySelectorAll(".contact-email").forEach((el) => (el.textContent = CONTACT_EMAIL));
  $("load-wait").classList.add("hidden");
  if (!configured) return setMessage("message", "js/config.js に Supabase の URL とキーを設定してください。", "error");
  if (isAdmin) {
    $("admin-note").classList.remove("hidden");
    return;
  }
  mode = profile ? "member" : "guest";
  if (mode === "member") {
    $("member-fields").classList.remove("hidden");
    $("member-no").textContent = profile.employee_no;
    $("member-name").textContent = `${profile.family_name} ${profile.given_name}`;
    // 所属の表示は、読めてから入れる(読み込みが遅くても、先にフォームを出す)
    $("member-office").textContent = "読み込み中…";
    memberOfficeName(session).then((name) => ($("member-office").textContent = name)).catch(() => ($("member-office").textContent = "未設定"));
    $("screen-help").textContent = "下の「これまでのお問い合わせ」に出ます";
    $("mail-label").textContent = "メールでも受け取る";
    $("mail-help").textContent = "画面にも残ります";
    $("intro").textContent = "使い方がわからない・うまく動かないときは、ここから送ってください。管理者に届きます。";
    $("mine-section").classList.remove("hidden");
    loadMine();
  } else {
    $("guest-fields").classList.remove("hidden");
    $("screen-help").textContent = "送ったあとに出る受付番号と確認コードで見ます";
    $("mail-help").textContent = "入れたアドレスに届きます";
    $("view-section").classList.remove("hidden");
    setOfficeOptions([]);
  }
  startNew();
  applyDraft(loadDraft());
  updateEmailFields();
  updateCount();
  renderThumbs();
  $("contact-form").classList.remove("hidden");
  if (mode === "guest") loadOffices(); // フォームを出したあとに読む(遅くても、フォームが出ない画面にならない)
}

main().catch((err) => {
  $("load-wait").classList.add("hidden");
  setMessage("message", err.message || String(err), "error");
  $("contact-form").classList.remove("hidden");
});
