// 全画面で使う共通処理: Supabase の初期化、ログイン状態の確認、上のナビ、Edge Function の呼び出し
//
// ログインは Edge Function(login / admin-login)が返すセッションを、ここで受け取って保存する。
// 利用者は社員番号+PIN、管理者は管理用パスワード。

// 版を固定する(「2 の最新」だと、新しい版が出たときに全員の画面が一度に変わってしまうため)。
// 上げるときは、ここを書き換えて動作を確かめる
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { APP_VERSION, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js?v=dev";

export const configured = !SUPABASE_URL.includes("YOUR-PROJECT-REF");

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export const $ = (id) => document.getElementById(id);

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
  if (!loggedIn) links.push(["index.html", "ログイン"]);
  else if (isAdmin) links.push(["admin.html", "管理"]);
  else links.push(["input.html", "勤務入力"], ["settings.html", "設定"]);
  links.push(["help.html", "使い方"]);

  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = !loggedIn ? "index.html" : isAdmin ? "admin.html" : "input.html";
  brand.textContent = "shiftflow";
  const ver = document.createElement("span");
  ver.className = "version";
  ver.textContent = APP_VERSION;
  brand.appendChild(ver);
  bar.appendChild(brand);

  links.forEach(([href, label]) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (href === current) a.className = "current";
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
  // 通信に失敗すると、この端末のログインが残ったままになる(次に開くと勝手に入る)。
  // そのときは、この端末のログインだけでも必ず消す
  const { error } = await supabase.auth.signOut().catch((err) => ({ error: err }));
  if (error) await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  go("index.html");
}

// Edge Function を呼ぶ。失敗したら、画面に出せるメッセージ付きの Error を投げる
export async function callFunction(name, body = {}) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return data;
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
  // ログインが無くなっていた(ほかの端末でPINを変えた・再設定された・削除された)ときは、ログイン画面へ
  if (code === "unauthenticated" || code === "not_member") {
    await loginLost("ログインが切れました。もう一度ログインしてください。");
  }
  throw err;
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

export async function loadSettings(session) {
  const { data, error } = await supabase
    .from("user_settings")
    .select("work_calendar_id, holiday_calendar_id, verified_at, office_id, split_day_events")
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
