// 最初の画面: 利用者(社員番号+PIN)と管理(管理用パスワード)のタブ
import {
  $, callFunction, configured, currentSession, go, homePageFor, loadProfile, renderTopbar, startSession, supabase, toHalfWidth,
} from "./app.js?v=dev";

renderTopbar("index.html");

function setMessage(id, text, kind) {
  $(id).textContent = text || "";
  $(id).className = "message" + (kind ? " " + kind : "");
}

function showTab(name) {
  const isUser = name === "user";
  $("user-form").classList.toggle("hidden", !isUser);
  $("admin-form").classList.toggle("hidden", isUser);
  $("tab-user").classList.toggle("active", isUser);
  $("tab-admin").classList.toggle("active", !isUser);
  $("tab-user").setAttribute("aria-selected", String(isUser));
  $("tab-admin").setAttribute("aria-selected", String(!isUser));
  (isUser ? $("employee-no") : $("admin-password")).focus();
}
// 管理者のブックマーク(index.html#admin)を、同じページから開いたときも管理タブにする
window.addEventListener("hashchange", () => showTab(location.hash === "#admin" ? "admin" : "user"));
$("tab-user").addEventListener("click", () => showTab("user"));
$("tab-admin").addEventListener("click", () => showTab("admin"));

// ボタンは押せるままにして、押したときに入力を確かめる
// (ブラウザが保存したパスワードを自動で入れたときは入力の合図が来ないことがあり、押せないままになるため)
function userProblem() {
  if (!/^\d{7}$/.test(toHalfWidth($("employee-no").value))) return "社員番号は7桁の数字で入力してください。";
  if (!/^\d{4}$/.test(toHalfWidth($("pin").value))) return "PINは4桁の数字で入力してください。";
  return "";
}

async function loginWith(fn, body, messageId, buttonId) {
  $(buttonId).disabled = true;
  setMessage(messageId, "ログインしています…");
  try {
    const { session } = await callFunction(fn, body);
    await startSession(session);
    const s = await currentSession();
    const profile = await loadProfile(s);
    if (!profile) throw new Error("このアカウントは利用できません。");
    go(await homePageFor(s, profile));
  } catch (err) {
    setMessage(messageId, err.message || String(err), "error");
    $(buttonId).disabled = false;
  }
}

$("user-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const problem = userProblem();
  if (problem) return setMessage("user-message", problem, "error");
  loginWith("login", { employee_no: toHalfWidth($("employee-no").value), pin: toHalfWidth($("pin").value) }, "user-message", "user-login");
});
$("admin-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!$("admin-password").value) return setMessage("admin-message", "管理用パスワードを入力してください。", "error");
  loginWith("admin-login", { password: $("admin-password").value }, "admin-message", "admin-login");
});

async function main() {
  if (!configured) {
    setMessage("user-message", "js/config.js に Supabase の URL とキーを設定してください。", "error");
    return;
  }
  if (location.hash === "#admin") showTab("admin");
  // 前回のログインが残っていれば、そのまま先へ進む。
  // 確かめている間(通信が遅いと数秒かかる)は入力できないようにする。
  // 入力中に確認が終わって、勝手に先へ進んだように見えないように
  const session = await currentSession();
  if (!session) return;
  setFormsBusy(true);
  const messageId = location.hash === "#admin" ? "admin-message" : "user-message";
  setMessage(messageId, "前回のログインを確認しています…");
  try {
    const profile = await loadProfile(session).catch(() => null);
    if (profile) return go(await homePageFor(session, profile));
    await supabase.auth.signOut({ scope: "local" });
    setMessage(messageId, "");
  } catch (err) {
    // 確かめられなかったときは、残っていたログインを捨てて入力し直してもらう
    await supabase.auth.signOut({ scope: "local" });
    setMessage(messageId, "");
  }
  setFormsBusy(false);
  (location.hash === "#admin" ? $("admin-password") : $("employee-no")).focus();
}

function setFormsBusy(busy) {
  document.querySelectorAll("#user-form input, #user-form button, #admin-form input, #admin-form button, .tabs button")
    .forEach((el) => (el.disabled = busy));
}

main().catch((err) => setMessage("user-message", err.message || String(err), "error"));
