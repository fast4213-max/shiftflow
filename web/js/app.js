// 全画面で使う共通処理: Supabase の初期化、ログイン状態の確認、上のナビ、Edge Function の呼び出し

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

export const configured = !SUPABASE_URL.includes("YOUR-PROJECT-REF");

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

export const $ = (id) => document.getElementById(id);

// このページと同じフォルダの別ページの URL(GitHub Pages のサブパスでも動くように)
export function pageUrl(name) {
  return new URL(name, location.href).href;
}

export function go(name) {
  location.replace(pageUrl(name));
}

// 上のナビ。current はいまのページのファイル名
export function renderTopbar(current, { loggedIn = false, isAdmin = false } = {}) {
  const bar = document.createElement("nav");
  bar.className = "topbar";
  const links = [];
  if (loggedIn) {
    links.push(["index.html", "勤務入力"], ["settings.html", "設定"]);
    if (isAdmin) links.push(["admin.html", "管理"]);
  }
  links.push(["help.html", "使い方"]);

  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = loggedIn ? "index.html" : "login.html";
  brand.textContent = "shiftflow";
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
      await supabase.auth.signOut();
      go("login.html");
    });
    bar.appendChild(out);
  }
  document.body.prepend(bar);
}

export async function currentSession() {
  if (!configured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// 自分が許可リストに入っているか(本人の行だけ読める)
export async function loadMembership(session) {
  const email = (session.user.email || "").toLowerCase();
  const { data, error } = await supabase.from("members").select("email, is_admin").eq("email", email).maybeSingle();
  if (error) throw error;
  return data;
}

export async function loadSettings(session) {
  const { data, error } = await supabase
    .from("user_settings")
    .select("work_calendar_id, holiday_calendar_id, verified_at")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function showNotAllowed(email) {
  document.body.innerHTML = "";
  renderTopbar("", { loggedIn: false });
  const main = document.createElement("main");
  main.className = "page";
  main.innerHTML = `
    <h1>利用が許可されていません</h1>
    <div class="card">
      <p><span class="mono"></span> は、まだこのアプリの利用者として登録されていません。</p>
      <p>管理者に、このメールアドレスで利用できるようにしてもらってください。登録されたら、もう一度ログインしてください。</p>
      <button id="logout-not-allowed">別のアカウントでログイン</button>
    </div>`;
  main.querySelector(".mono").textContent = email;
  document.body.appendChild(main);
  $("logout-not-allowed").addEventListener("click", async () => {
    await supabase.auth.signOut();
    go("login.html");
  });
}

// ログイン必須のページの入口。
//   needVerified: 接続テスト済みでなければ設定画面へ
//   needAdmin   : 管理者でなければ勤務入力へ
// 戻り値: { session, member, settings }(移動するときは null)
export async function requireLogin(current, { needVerified = false, needAdmin = false } = {}) {
  const session = await currentSession();
  if (!session) {
    go("login.html");
    return null;
  }
  const member = await loadMembership(session);
  if (!member) {
    showNotAllowed(session.user.email || "");
    return null;
  }
  if (needAdmin && !member.is_admin) {
    go("index.html");
    return null;
  }
  const settings = await loadSettings(session);
  if (needVerified && !(settings && settings.verified_at)) {
    go("settings.html");
    return null;
  }
  renderTopbar(current, { loggedIn: true, isAdmin: member.is_admin });
  return { session, member, settings };
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
  throw err;
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
