// 新規登録: 社員番号・名字・名前・PIN・共通パスワード。登録したらそのままログインして設定画面へ
import {
  $, AUTOFILL_HINT, callFunction, canSaveLogin, configured, go, renderTopbar, sharedPasswordProblem, startSession, STORAGE_HELP,
  toHalfWidth,
} from "./app.js?v=dev";

renderTopbar("register.html");

function setMessage(text, kind) {
  $("message").textContent = text || "";
  $("message").className = "message" + (kind ? " " + kind : "");
}

function problem() {
  if (!/^\d{7}$/.test(toHalfWidth($("employee-no").value))) return "社員番号は7桁の数字で入力してください。";
  if (!$("family-name").value.trim()) return "名字を入力してください。";
  if (!$("given-name").value.trim()) return "名前を入力してください。";
  if (!/^\d{4}$/.test(toHalfWidth($("pin").value))) return "PINは4桁の数字で入力してください。";
  if (toHalfWidth($("pin").value) !== toHalfWidth($("pin2").value)) return "PINが2回で一致しません。";
  if (!$("shared").value) return "共通パスワードを入力してください。";
  return sharedPasswordProblem($("shared").value);
}

$("form").addEventListener("input", (ev) => {
  if (!canSaveLogin()) return;
  $("submit").disabled = !!problem();
  // 社員番号・PINの欄に形の違う値が自動で入って消したとき(app.js の bindDigitsOnly)は、その案内を出す
  // 共通パスワードに全角やかなが入ったときは、その場で知らせる(押せないままの理由が分かるように)
  const message = ev.target.dataset && ev.target.dataset.rejected ? AUTOFILL_HINT
    : ev.target.id === "shared" ? sharedPasswordProblem($("shared").value) : "";
  setMessage(message, "error");
});
$("submit").disabled = true;
// ログインを保存できない(Safari の「すべてのCookieをブロック」など)と、登録してもそのまま使えないので先に知らせる
if (!canSaveLogin()) setMessage(STORAGE_HELP, "error");
else if (document.querySelector("#form [data-rejected]")) setMessage(AUTOFILL_HINT, "error");

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const p = problem();
  if (p) return setMessage(p, "error");
  if (!configured) return setMessage("js/config.js に Supabase の URL とキーを設定してください。", "error");
  $("submit").disabled = true;
  setMessage("登録しています…");
  const employeeNo = toHalfWidth($("employee-no").value);
  const pin = toHalfWidth($("pin").value);
  try {
    await callFunction("sign-up", {
      employee_no: employeeNo,
      family_name: $("family-name").value.trim(),
      given_name: $("given-name").value.trim(),
      pin,
      shared_password: $("shared").value,
    });
  } catch (err) {
    setMessage(err.message || String(err), "error");
    $("submit").disabled = false;
    return;
  }
  try {
    const { session } = await callFunction("login", { employee_no: employeeNo, pin });
    await startSession(session);
    go("settings.html");
  } catch (err) {
    // 登録はできている(もう一度「登録する」を押すと「すでに登録されています」になる)ので、ログイン画面へ案内する
    setMessage("登録はできました。続けてのログインに失敗したので、下の「ログインに戻る」から社員番号とPINでログインしてください。(" +
      (err.message || String(err)) + ")", "error");
  }
});
