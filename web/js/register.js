// 新規登録: 社員番号・名字・名前・PIN・共通パスワード。登録したらそのままログインして設定画面へ
import { $, callFunction, configured, go, renderTopbar, startSession, toHalfWidth } from "./app.js";

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
  return "";
}

$("form").addEventListener("input", () => {
  $("submit").disabled = !!problem();
  setMessage("");
});
$("submit").disabled = true;

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const p = problem();
  if (p) return setMessage(p, "error");
  if (!configured) return setMessage("js/config.js に Supabase の URL とキーを設定してください。", "error");
  $("submit").disabled = true;
  setMessage("登録しています…");
  try {
    const employeeNo = toHalfWidth($("employee-no").value);
    const pin = toHalfWidth($("pin").value);
    await callFunction("sign-up", {
      employee_no: employeeNo,
      family_name: $("family-name").value.trim(),
      given_name: $("given-name").value.trim(),
      pin,
      shared_password: $("shared").value,
    });
    const { session } = await callFunction("login", { employee_no: employeeNo, pin });
    await startSession(session);
    go("settings.html");
  } catch (err) {
    setMessage(err.message || String(err), "error");
    $("submit").disabled = false;
  }
});
