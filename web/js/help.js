// 使い方ページ。未ログインでも読める。
// ログイン済みの利用者にだけ、登録用アドレス(サービスアカウントのメール)を表示する。
import { $, callFunction, copyText, currentSession, loadProfile, renderTopbar } from "./app.js";

async function main() {
  let session = null;
  let profile = null;
  try {
    session = await currentSession();
    if (session) profile = await loadProfile(session);
  } catch (_) { /* 読めなくても使い方は表示する */ }
  renderTopbar("help.html", { loggedIn: !!profile, isAdmin: !!(profile && profile.role === "admin") });
  if (!profile) return;

  try {
    const config = await callFunction("app-config");
    $("sa-email").value = config.serviceAccountEmail;
    $("sa-box").classList.remove("hidden");
    $("sa-login").classList.add("hidden");
    $("copy-sa").addEventListener("click", () => copyText($("sa-email").value, $("copy-sa")));
  } catch (_) { /* 表示できなければ設定画面の案内のまま */ }
}

main();
