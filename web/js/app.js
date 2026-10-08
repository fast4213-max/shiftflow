// 全画面で使う共通処理: Supabase の初期化、ログイン状態の確認、上のナビ、Edge Function の呼び出し
//
// ログインは Edge Function(login / admin-login)が返すセッションを、ここで受け取って保存する。
// 利用者は社員番号+PIN、管理者は管理用パスワード。

// supabase-js は CDN から借りず、このリポジトリに置いたファイルを使う(CDN の障害や取り下げで全員の画面が止まらないように)。
// 版はファイル名のとおり 2.117.2 で固定。上げるときは vendor/README.md の手順でファイルを作り直し、ここを書き換えて動作を確かめる
import { createClient } from "./vendor/supabase-js.2.117.2.min.js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js?v=dev";

export const configured = !SUPABASE_URL.includes("YOUR-PROJECT-REF");

// 公開した直後の10分ほどは、キャッシュで古い HTML と新しい JS が混ざることがある(画面の id や関数が合わず、止まる)。
// この JS の版(?v=…。公開のたびに変わる)と、HTML が読み込んだ最初の JS の版が違うときは、1回だけ読み直す。
// 読み直しても同じ版なら(または記録できない端末では)何もしない(読み直しを繰り返さない)。開発中(v=dev)は何もしない
(function reloadIfStaleHtml() {
  try {
    const mine = new URL(import.meta.url).searchParams.get("v");
    const entry = document.querySelector('script[type="module"][src]');
    const theirs = entry ? new URL(entry.src, location.href).searchParams.get("v") : null;
    if (!mine || !theirs || mine === "dev" || mine === theirs) return;
    const key = "shiftflow-reloaded-for";
    if (window.sessionStorage.getItem(key) === mine) return;
    window.sessionStorage.setItem(key, mine);
    location.reload();
  } catch (_) { /* 何もしない */ }
})();

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export const $ = (id) => document.getElementById(id);

// 「戻る」「進む」で、前の画面が一時保存(bfcache)から復元されたときは、読み直す。
// 復元された画面は、古い区所・お知らせ・ログイン状態のまま(ログアウトしたあとに「戻る」で、ログイン中の画面が見える)になるため
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) location.reload();
});

// 画面のプログラムが読み込めたしるし(HTML の onsubmit が見る。読み込めないときに、社員番号やPINを
// URL に付けて送ってしまわないよう、フォームの送信は止めて、読み込めなかったことを知らせる)
window.shiftflowReady = true;
// 読み込み中にボタンを押したときの「読み込み中です」を、読み込めたら消す
const loadWait = document.getElementById("load-wait");
if (loadWait) loadWait.classList.add("hidden");

// この端末にログインを保存できるか。Safari の「すべてのCookieをブロック」がオンなどだと保存できず、
// ログインしても次の画面でログイン画面に戻ってしまう(エラーも出ない)ので、先に確かめて知らせる
export function canSaveLogin() {
  try {
    const key = "shiftflow-storage-test";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

export const STORAGE_HELP =
  "この画面ではログインを保存できません。iPhoneは「設定」→「アプリ」→「Safari」(iOSによっては「設定」→「Safari」)の" +
  "「すべてのCookieをブロック」をオフにしてから、開き直してください。プライベートブラウズのときは、通常のタブで開いてください。" +
  "Android(Chrome)は、右上の「︙」→「設定」→「サイトの設定」で、このサイトのCookie(サイトのデータ)を許可してから、開き直してください。";

// 社員番号・PINの欄に、形の違う値が自動で入ったので消したときの案内(bindDigitsOnly)
export const AUTOFILL_HINT = "自動で入った値が社員番号・PINの形ではなかったので消しました。手で入力してください" +
  "(スマホに保存されたパスワードが名前や共通パスワードになっていることや、スマホがすすめるパスワードは使えません)。";

// 共通パスワードは半角の英数字・記号だけにする(スマホの日本語キーボードで、かなや全角が入って
// 「違います」になり、同じ接続元の人の新規登録まで止めてしまわないように)
export function sharedPasswordProblem(value) {
  return /[^\x20-\x7e]/.test(value) ? "共通パスワードは半角の英数字・記号で入力してください(全角やかなが入っています)。" : "";
}

// このページと同じフォルダの別ページの URL(GitHub Pages のサブパスでも動くように)
export function pageUrl(name) {
  return new URL(name, location.href).href;
}

export function go(name) {
  location.replace(pageUrl(name));
}

// 上のナビ。current は今のページのファイル名
export function renderTopbar(current, { loggedIn = false, isAdmin = false } = {}) {
  const bar = document.createElement("nav");
  bar.className = "topbar";
  const links = [];
  if (!loggedIn) links.push(["index.html", "ログイン"], ["contact.html", "お問い合わせ"]);
  else if (isAdmin) links.push(["admin.html", "管理"]);
  else links.push(["input.html", "勤務入力"], ["settings.html", "設定"], ["notices.html", "お知らせ"], ["contact.html", "お問い合わせ"]);
  links.push(["help.html", "使い方"]);

  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = !loggedIn ? "index.html" : isAdmin ? "admin.html" : "input.html";
  brand.textContent = "shiftflow";
  bar.appendChild(brand);

  links.forEach(([href, label]) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (href === current) a.className = "current";
    if (href === "notices.html") a.id = "nav-notices";
    bar.appendChild(a);
  });

  if (loggedIn) {
    const out = document.createElement("a");
    out.href = "#";
    out.textContent = "ログアウト";
    out.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await logout();
    });
    bar.appendChild(out);
  }
  document.body.prepend(bar);
  // まだ見ていないお知らせがあれば、メニューの「お知らせ」に赤い点を付ける(失敗しても何もしない)
  if (loggedIn && !isAdmin && current !== "notices.html") {
    fetchNotices().then((list) => {
      if (list && unseenNotices(list).length) $("nav-notices")?.classList.add("has-dot");
    }).catch(() => {});
  }
}

// ---------- お知らせ ----------

const NOTICES_SEEN_KEY = "shiftflow-notices-seen";

function noticeKey(n) {
  return `${n.id}:${n.updated_at}`;
}

// いま表示するお知らせ(重要が先、新しい順)。読めない・遅い(6秒)ときは null(ログインなどの動きを止めない。
// 「お知らせが0件」と「読めなかった」を区別して、読めなかったときに「見た記録」を空で上書きしないため)
export async function fetchNotices() {
  if (!configured) return null;
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ data: null, error: new Error("timeout") }), 6000));
  try {
    const { data, error } = await Promise.race([supabase.rpc("current_notices"), timeout]);
    if (error || !Array.isArray(data)) return null;
    return data.filter((n) => n && typeof n.title === "string");
  } catch (_) {
    return null;
  }
}

// まだ見ていないお知らせ。見た記録をこの端末に保存できないときは、点を出さない(空を返す)
export function unseenNotices(list) {
  try {
    const seen = JSON.parse(window.localStorage.getItem(NOTICES_SEEN_KEY) || "[]");
    if (!Array.isArray(seen)) return list;
    return list.filter((n) => !seen.includes(noticeKey(n)));
  } catch (_) {
    return [];
  }
}

export function markNoticesSeen(list) {
  try {
    window.localStorage.setItem(NOTICES_SEEN_KEY, JSON.stringify(list.map(noticeKey)));
  } catch (_) { /* 保存できない端末では何もしない */ }
}

// 日付("2026-10-06")を "10/6" に
export function shortDate(value) {
  const m = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
}

// お知らせ1件の表示。文字は textContent だけで入れる(HTML として読まない)。
// clamp: 本文が長いときは途中までにして「続きを読む」を付ける(ログイン画面用)
export function noticeElement(n, { clamp = 0, isNew = false } = {}) {
  const item = document.createElement("div");
  item.className = "notice-item" + (n.level === "important" ? " important" : "");
  const head = document.createElement("div");
  head.className = "notice-head";
  if (n.level === "important") {
    const badge = document.createElement("span");
    badge.className = "notice-badge";
    badge.textContent = "重要";
    head.appendChild(badge);
  }
  const date = document.createElement("span");
  date.className = "notice-date";
  date.textContent = shortDate(n.starts_on);
  head.appendChild(date);
  if (isNew) {
    const badge = document.createElement("span");
    badge.className = "notice-new";
    badge.textContent = "NEW";
    head.appendChild(badge);
  }
  const title = document.createElement("div");
  title.className = "notice-title";
  title.textContent = n.title;
  item.append(head, title);
  const text = String(n.body || "");
  if (text) {
    const body = document.createElement("div");
    body.className = "notice-body";
    const chars = [...text];
    if (clamp && chars.length > clamp) {
      body.textContent = chars.slice(0, clamp).join("") + "…";
      const more = document.createElement("button");
      more.type = "button";
      more.className = "link-button";
      more.textContent = "続きを読む";
      more.addEventListener("click", () => {
        body.textContent = text;
        more.remove();
      });
      item.append(body, more);
    } else {
      body.textContent = text;
      item.appendChild(body);
    }
  }
  return item;
}

// 画面ごとに1つ使う、使い捨てのキー(二度押し・送り直しで2件にしないため)
export function newRequestKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ログインが無くなった(PINの再設定・変更でほかの端末から消された・削除された)ときに、
// この端末のログインを消してログイン画面へ移る。何度も呼ばれても1回だけ
let leaving = false;
export async function loginLost(message) {
  if (leaving) return;
  leaving = true;
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  if (message) alert(message);
  go("index.html");
}

// ログインが必要な画面(勤務入力・設定・管理)を開いているときに、ライブラリがログインの更新に失敗して
// ログインを消した(ほかの端末・ほかのタブでPINを変えたなど)ら、ログイン画面へ移る
let loginRequired = false;
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" && loginRequired) loginLost("ログインが切れました。もう一度ログインしてください。");
});

export async function logout() {
  loginRequired = false; // 自分でログアウトしたときは「切れました」を出さない
  // この端末のログインだけを消す(S5。ほかの端末・管理画面を開いているほかの PC はログインしたまま)。
  // supabase-js は、通信に失敗しても、この端末に保存したログインは必ず消す
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  go("index.html");
}

// 通信エラー(ブラウザの英語のメッセージ)を日本語にする。直接の読み書き(supabase-js)のエラーが、そのまま画面に出ないように
export function friendlyText(text) {
  const t = String(text || "");
  if (/Failed to fetch|Load failed|NetworkError|Network request failed|fetch failed|Network error/i.test(t)) {
    return "通信に失敗しました。電波の良いところで、もう一度お試しください。";
  }
  return t;
}

// Edge Function を呼ぶ。失敗したら、画面に出せるメッセージ付きの Error を投げる
// stayOnLoss: ログインが切れていても、ログイン画面へ移らない(未ログインでも読める使い方ページ用)
// timeoutMs: 返事を待つ時間(電波が悪いと、いつまでも「読み込み中」のままにならないように。既定30秒。
//   登録・削除は Google の混雑の再試行で2分近くかかることがあるので長くする)。時間切れになっても、サーバー側の処理は続くことがある
export async function callFunction(name, body = {}, { stayOnLoss = false, timeoutMs = 30000 } = {}) {
  let { data: result, err } = await invokeOnce(name, body, timeoutMs);
  if (!err) return result;
  // 「ログインが切れた」と言われても、圏外のあいだにログインの更新(1時間ごと)ができなかっただけのことがある
  // (supabase-js は更新に失敗すると、1分ほど同じ失敗を使い回し、その間はログインの代わりに公開用のキーで送るため)。
  // ここでログインの更新をやり直し、できたら1回だけ送り直す。サーバーはログインを確かめる前に止まっているので、送り直しても二重にならない(S2)
  if (err.code === "unauthenticated") {
    const { data, error } = await supabase.auth.refreshSession().catch((e) => ({ data: null, error: e }));
    if (data && data.session) {
      ({ data: result, err } = await invokeOnce(name, body, timeoutMs));
      if (!err) return result;
    } else if (error && isRetryableAuthError(error)) {
      // 通信がまだ不安定で、ログインが本当に切れたかは分からない。ログインと入力は消さない
      const e = new Error("通信が不安定なため、ログインを確かめられませんでした。電波の良いところで、少し待ってからもう一度お試しください。");
      e.code = "auth_unavailable";
      throw e;
    }
  }
  // ログインが無くなっていた(ほかの端末でPINを変えた・再設定された・削除された)ときは、ログイン画面へ
  if (!stayOnLoss && (err.code === "unauthenticated" || err.code === "not_member")) {
    await loginLost("ログインが切れました。もう一度ログインしてください。");
  }
  throw err;
}

// ログインの更新の失敗が、通信の問題(もう一度やれば通るかもしれない)か
function isRetryableAuthError(error) {
  const status = Number(error.status || 0);
  return error.name === "AuthRetryableFetchError" || status === 0 || status === 429 || status >= 500;
}

// Edge Function を1回呼ぶ。成功したら { data }、失敗したら { err }(画面に出せる Error)を返す
async function invokeOnce(name, body, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ data: null, error: { timedOut: true } }), timeoutMs);
  });
  const { data, error } = await Promise.race([supabase.functions.invoke(name, { body }), timeout]).finally(() => clearTimeout(timer));
  if (!error) return { data, err: null };
  if (error.timedOut) {
    const err = new Error("通信に時間がかかっています。電波の良いところで、もう一度お試しください(処理が続いていることもあるので、結果を確かめてください)。");
    err.code = "timeout";
    return { data: null, err };
  }
  let message = "通信に失敗しました。電波の良いところでもう一度お試しください。";
  let code = "";
  try {
    const res = error.context;
    if (res && typeof res.json === "function") {
      const json = await res.json();
      if (json && json.error) message = json.error;
      if (json && json.code) code = json.code;
    }
  } catch (_) { /* JSON でなければ既定のメッセージ */ }
  const err = new Error(message);
  err.code = code;
  return { data: null, err };
}

// Edge Function が返したセッションを保存してログイン状態にする
export async function startSession(session) {
  const { error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw error;
}

export async function currentSession() {
  if (!configured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// 自分のプロフィール(社員番号・名前・権限)。無ければ null
export async function loadProfile(session) {
  const { data, error } = await supabase
    .from("profiles")
    .select("employee_no, family_name, given_name, role")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// 列は「*」で読む(設定の列を足したとき、画面が DB より先に反映されても、ログインのたびに読めなくならないように)
export async function loadSettings(session) {
  const { data, error } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function isReady(settings) {
  return !!(settings && settings.verified_at && settings.office_id);
}

// ログイン後に最初に行くページ
export async function homePageFor(session, profile) {
  if (profile.role === "admin") return "admin.html";
  return isReady(await loadSettings(session)) ? "input.html" : "settings.html";
}

// ログイン必須のページの入口。
//   needVerified: 区所を選んでいない・接続テスト済みでなければ設定画面へ
//   needAdmin   : 管理者のページ(管理者以外は勤務入力へ)。利用者のページは管理者を管理画面へ返す
// 戻り値: { session, profile, settings }(移動するときは null)
export async function requireLogin(current, { needVerified = false, needAdmin = false } = {}) {
  const session = await currentSession();
  if (!session) {
    go("index.html");
    return null;
  }
  const profile = await loadProfile(session);
  if (!profile) {
    // ユーザーが消された(管理者が削除した)など
    await supabase.auth.signOut();
    go("index.html");
    return null;
  }
  const isAdmin = profile.role === "admin";
  if (needAdmin && !isAdmin) {
    go("input.html");
    return null;
  }
  if (!needAdmin && isAdmin && current !== "help.html") {
    go("admin.html");
    return null;
  }
  let settings = null;
  if (!isAdmin) {
    settings = await loadSettings(session);
    if (needVerified && !isReady(settings)) {
      go("settings.html");
      return null;
    }
  }
  renderTopbar(current, { loggedIn: true, isAdmin });
  loginRequired = true;
  return { session, profile, settings };
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (button) {
    const label = button.textContent;
    button.textContent = "コピーしました";
    setTimeout(() => (button.textContent = label), 1500);
  }
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 全角の数字を半角にする(スマホの日本語キーボード対策)
export function toHalfWidth(value) {
  return String(value || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
}

// data-digits の付いた入力欄(社員番号・PIN)は、半角の数字だけが入るようにする。
// 全角の数字は半角に直し、それ以外の文字は入力できない。長さは maxlength まで。
// ただし、1文字ずつ打ったのではなく(自動入力・貼り付け)、数字以外の文字(空白・ハイフンを除く)があるか
// 桁が多すぎるときは、iPhone などが保存した別の値(名前や共通パスワードなど)が自動で入ったとみなす。
// 切り詰めると違う社員番号・PINで送ってしまうので、空にして "digits-rejected" で知らせる
// (消した欄には data-rejected を付ける。画面のプログラムより先に入っていた値を消したときは、
// 各画面の知らせを受ける準備がまだなので、各画面はこの印を見て案内を出す)
function isTyping(ev) {
  // 最初の1回(画面のプログラムが動く前に入っていた値)は自動入力の扱い。日本語入力の確定(compositionend)は打った扱い
  if (!ev) return false;
  const type = ev.inputType;
  if (!type) return ev.type !== "input";
  if (type === "insertText") return (ev.data || "").length <= 1;
  return type === "insertCompositionText" || type.startsWith("delete");
}

function bindDigitsOnly(input) {
  const clean = (ev) => {
    const max = Number(input.getAttribute("maxlength")) || 0;
    const raw = toHalfWidth(input.value);
    let value = raw.replace(/\D/g, "");
    const rejected = !isTyping(ev) && (/[^\d\s\-ー－]/.test(raw) || (max && value.length > max));
    if (rejected) value = "";
    else if (max) value = value.slice(0, max);
    if (value !== input.value) input.value = value;
    if (rejected) {
      input.dataset.rejected = "1";
      input.dispatchEvent(new CustomEvent("digits-rejected"));
    } else {
      delete input.dataset.rejected;
    }
  };
  input.addEventListener("input", clean);
  input.addEventListener("compositionend", clean);
  input.setAttribute("inputmode", "numeric");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  clean();
}
document.querySelectorAll("input[data-digits]").forEach(bindDigitsOnly);
