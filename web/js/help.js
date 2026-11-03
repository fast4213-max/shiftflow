// 使い方ページ。未ログインでも読める。
// ログイン済みの利用者にだけ、登録用アドレス(サービスアカウントのメール)を表示する。
// 節は折りたためる(<details class="fold">)。目次・ほかのページからのリンクで、その節が自動で開く。
import { $, callFunction, copyText, currentSession, loadProfile, renderTopbar, showGuideLinks } from "./app.js?v=dev";

// 前の使い方にあった節のリンク(ほかのページ・ブックマーク)が、新しい節に行くように
const ALIAS = { intro: "app-setup", signup: "app-setup", settings: "google-phone", prepare: "google-phone", share: "google-phone", id: "google-pc", test: "google-info" };

// リンク先(#id)を含む折りたたみを、外側まで全部開いて、そこへ動く
function openTarget() {
  let id = decodeURIComponent((location.hash || "").slice(1));
  if (!id) return;
  let el = document.getElementById(id);
  if (!el && ALIAS[id]) el = document.getElementById(ALIAS[id]);
  if (!el) return;
  for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
  el.scrollIntoView({ block: "start" });
}

function bindFold() {
  const all = () => [...document.querySelectorAll("details.fold")];
  const btn = $("fold-all");
  if (btn) {
    btn.addEventListener("click", () => {
      const open = btn.dataset.open !== "1";
      all().forEach((d) => { d.open = open; });
      btn.dataset.open = open ? "1" : "0";
      btn.textContent = open ? "全部閉じる" : "全部開く";
    });
  }
  // 印刷のときは、全部開く(終わったら元に戻す)
  let saved = null;
  window.addEventListener("beforeprint", () => { saved = all().map((d) => d.open); all().forEach((d) => { d.open = true; }); });
  window.addEventListener("afterprint", () => { if (saved) all().forEach((d, i) => { d.open = saved[i]; }); saved = null; });
  window.addEventListener("hashchange", openTarget);
  openTarget();
}

async function main() {
  bindFold();
  showGuideLinks("guide").catch(() => {});
  let session = null;
  let profile = null;
  try {
    session = await currentSession();
    if (session) profile = await loadProfile(session);
  } catch (_) { /* 読めなくても使い方は表示する */ }
  renderTopbar("help.html", { loggedIn: !!profile, isAdmin: !!(profile && profile.role === "admin") });
  if (!profile) return;

  try {
    const config = await callFunction("app-config", {}, { stayOnLoss: true });
    $("sa-email").value = config.serviceAccountEmail;
    $("sa-box").classList.remove("hidden");
    $("sa-login").classList.add("hidden");
    $("copy-sa").addEventListener("click", () => copyText($("sa-email").value, $("copy-sa")));
  } catch (_) { /* 表示できなければ設定画面の案内のまま */ }
}

main();
