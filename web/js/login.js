import { $, configured, currentSession, go, loadMembership, loadSettings, pageUrl, renderTopbar, supabase } from "./app.js";

renderTopbar("login.html");

async function main() {
  if (!configured) {
    $("message").textContent = "js/config.js に Supabase の URL とキーを設定してください。";
    $("message").className = "error";
    return;
  }

  // Google から戻ってきたとき(?code=...)は、supabase-js がログイン状態を作ってくれる
  const params = new URLSearchParams(location.search);
  if (params.get("error_description")) {
    $("message").textContent = "ログインできませんでした: " + params.get("error_description");
    $("message").className = "error";
  } else {
    $("message").textContent = "";
  }

  const session = await currentSession();
  if (session) {
    $("message").textContent = "ログイン済みです。移動しています…";
    const member = await loadMembership(session);
    if (!member) return go("index.html"); // 許可されていない案内は index 側で出す
    const settings = await loadSettings(session);
    return go(settings && settings.verified_at ? "index.html" : "settings.html");
  }

  $("login").disabled = false;
  $("login").addEventListener("click", async () => {
    $("login").disabled = true;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: pageUrl("login.html") },
    });
    if (error) {
      $("login").disabled = false;
      $("message").textContent = "ログインを始められませんでした: " + error.message;
      $("message").className = "error";
    }
  });
}

main().catch((err) => {
  $("message").textContent = err.message || String(err);
  $("message").className = "error";
});
