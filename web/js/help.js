// 使い方ページ。未ログインでも読める。
// ログイン済みの利用者にだけ、登録用アドレス(サービスアカウントのメール)を表示する。
import { $, callFunction, copyText, currentSession, loadMembership, renderTopbar } from "./app.js";

async function main() {
  let session = null;
  let member = null;
  try {
    session = await currentSession();
    if (session) member = await loadMembership(session);
  } catch (_) { /* 読めなくても使い方は表示する */ }
  renderTopbar("help.html", { loggedIn: !!member, isAdmin: !!(member && member.is_admin) });
  if (!member) return;

  try {
    const config = await callFunction("app-config");
    $("sa-email").value = config.serviceAccountEmail;
    $("sa-box").classList.remove("hidden");
    $("sa-login").classList.add("hidden");
    $("copy-sa").addEventListener("click", () => copyText($("sa-email").value, $("copy-sa")));
  } catch (_) { /* 表示できなければ設定画面の案内のまま */ }
}

main();
