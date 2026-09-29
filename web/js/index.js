// 最初の画面: 利用者(社員番号+PIN)と管理(管理用パスワード)のタブ
import {
  $, callFunction, configured, currentSession, go, homePageFor, loadProfile, renderTopbar, startSession, supabase, toHalfWidth,
} from "./app.js";

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
$("tab-user").addEventListener("click", () => showTab("user"));
$("tab-admin").addEventListener("click", () => showTab("admin"));

// 入力がそろったらボタンを押せるようにする
function watch(form, button, ready) {
  const update = () => ($(button).disabled = !ready());
  $(form).addEventListener("input", update);
  update();
}
watch("user-form", "user-login", () => /^\d{7}$/.test(toHalfWidth($("employee-no").value)) && /^\d{6}$/.test(toHalfWidth($("pin").value)));
watch("admin-form", "admin-login", () => $("admin-password").value.length > 0);

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
  loginWith("login", { employee_no: toHalfWidth($("employee-no").value), pin: toHalfWidth($("pin").value) }, "user-message", "user-login");
});
$("admin-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  loginWith("admin-login", { password: $("admin-password").value }, "admin-message", "admin-login");
});

async function main() {
  if (!configured) {
    setMessage("user-message", "js/config.js に Supabase の URL とキーを設定してください。", "error");
    return;
  }
  // すでにログインしていれば、そのまま先へ進む
  const session = await currentSession();
  if (session) {
    const profile = await loadProfile(session).catch(() => null);
    if (profile) return go(await homePageFor(session, profile));
    await supabase.auth.signOut();
  }
  if (location.hash === "#admin") showTab("admin");
}

main().catch((err) => setMessage("user-message", err.message || String(err), "error"));
