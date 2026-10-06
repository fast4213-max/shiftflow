// 最初の画面: 利用者(社員番号+PIN)と管理(管理用パスワード)のタブ
import {
  friendlyText, $, AUTOFILL_HINT, callFunction, canSaveLogin, configured, currentSession, fetchNotices, go, homePageFor, loadProfile, noticeElement,
  renderTopbar, startSession, STORAGE_HELP, supabase, toHalfWidth,
} from "./app.js?v=dev";

renderTopbar("index.html");

// お知らせ(利用者タブの、タブと入力欄の間。最大3件)。ログインの動きとは別に読み、失敗しても何も出さない。
// 読み終わる前に入力を始めていたら、欄が下にずれて押し間違えないよう、ログインボタンの下に出す(N2)
async function showLoginNotices() {
  const list = ((await fetchNotices()) || []).slice(0, 3);
  if (!list.length) return;
  const box = $("login-notices");
  const heading = document.createElement("div");
  heading.className = "notices-heading";
  heading.textContent = "📢 お知らせ";
  box.appendChild(heading);
  list.forEach((n) => box.appendChild(noticeElement(n, { clamp: 80 })));
  const typing = document.activeElement && $("user-form").contains(document.activeElement) && document.activeElement.tagName === "INPUT";
  if (typing || $("employee-no").value || $("pin").value) {
    box.classList.add("below");
    $("user-form").appendChild(box);
  }
  box.classList.remove("hidden");
}
showLoginNotices().catch(() => {});

function setMessage(id, text, kind) {
  $(id).textContent = friendlyText(text) || "";
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

// iPhone などが保存した値が自動で入って、社員番号・PINの形でなかったとき(app.js の bindDigitsOnly が空にする)。
// 画面のプログラムより先に入っていて、もう消してあったときも案内する
["employee-no", "pin"].forEach((id) => {
  $(id).addEventListener("digits-rejected", () => setMessage("user-message", AUTOFILL_HINT, "error"));
  if ($(id).dataset.rejected) setMessage("user-message", AUTOFILL_HINT, "error");
});

// ボタンは押せるままにして、押したときに入力を確かめる
// (ブラウザが保存したパスワードを自動で入れたときは入力の合図が来ないことがあり、押せないままになるため)
function userProblem() {
  const employeeNo = toHalfWidth($("employee-no").value);
  const pin = toHalfWidth($("pin").value);
  // 入力の合図なしに自動で入った値(数字以外の文字がある)は、上と同じ案内にする
  if (/[^\d\s]/.test(employeeNo + pin)) return AUTOFILL_HINT;
  if (!/^\d{7}$/.test(employeeNo)) return "社員番号は7桁の数字で入力してください。";
  if (!/^\d{4}$/.test(pin)) return "PINは4桁の数字で入力してください。";
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
  // ログインを保存できない(Safari の「すべてのCookieをブロック」など)と、ログインしても
  // 次の画面でここに戻ってしまう。入れないようにして、直し方を出す
  if (!canSaveLogin()) {
    setFormsBusy(true);
    setMessage(location.hash === "#admin" ? "admin-message" : "user-message", STORAGE_HELP, "error");
    return;
  }
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
