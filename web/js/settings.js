// 設定: 区所とカレンダーIDだけ。保存すると、そのまま接続テストをする。
import {
  $, AUTOFILL_HINT, callFunction, copyText, isReady, loginLost, requireLogin, startSession, supabase, toHalfWidth,
} from "./app.js?v=dev";

let session = null;
let settings = null; // user_settings の行(無ければ null)

function message(id, text, kind) {
  $(id).textContent = text || "";
  $(id).className = "message" + (kind ? " " + kind : "");
}

function updateGoInput() {
  $("go-input").classList.toggle("hidden", !isReady(settings));
}

// 利用者が書けるのは区所とカレンダーIDの列だけ(検証済みフラグは Edge Function が書く)
async function saveSettings(values) {
  const columns = "work_calendar_id, holiday_calendar_id, verified_at, office_id, split_day_events";
  const { data, error } = settings
    ? await supabase.from("user_settings").update(values).eq("user_id", session.user.id).select(columns).single()
    : await supabase.from("user_settings").insert({ user_id: session.user.id, ...values }).select(columns).single();
  if (error) throw error;
  settings = data;
}

async function loadOffices() {
  const { data, error } = await supabase.from("offices").select("id, name").order("sort_order").order("id");
  if (error) throw error;
  const select = $("office");
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = data.length ? "選んでください" : "区所がまだありません(管理者に頼んでください)";
  select.appendChild(empty);
  data.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.name;
    select.appendChild(opt);
  });
  select.value = settings && settings.office_id ? String(settings.office_id) : "";
}

async function main() {
  const ctx = await requireLogin("settings.html");
  if (!ctx) return;
  session = ctx.session;
  settings = ctx.settings;
  $("who").textContent = `${ctx.profile.family_name} ${ctx.profile.given_name}(社員番号 ${ctx.profile.employee_no})`;
  $("pin-user").value = ctx.profile.employee_no;

  if (settings) {
    $("work-id").value = settings.work_calendar_id || "";
    $("holiday-id").value = settings.holiday_calendar_id || "";
    $("split-day").checked = !!settings.split_day_events;
  }
  if (!isReady(settings)) $("first-time").classList.remove("hidden");
  if (isReady(settings)) message("result", "接続テスト済みです。", "ok");
  updateGoInput();

  loadOffices().catch((err) => message("result", err.message || String(err), "error"));

  callFunction("app-config")
    .then((config) => ($("sa-email").value = config.serviceAccountEmail))
    .catch((err) => ($("sa-email").value = "取得できませんでした: " + err.message));
  $("copy-sa").addEventListener("click", () => copyText($("sa-email").value, $("copy-sa")));

  // 区所・ID・「出勤を2件で登録する」を変えたら、保存するまでテスト済みの表示と「勤務入力へ」を消す
  // (保存せずに勤務入力へ進むと、変えた設定が使われないため)
  ["office", "work-id", "holiday-id", "split-day"].forEach((id) =>
    $(id).addEventListener(id === "office" || id === "split-day" ? "change" : "input", () => {
      message("result", "");
      $("go-input").classList.add("hidden");
    })
  );

  $("save").addEventListener("click", async () => {
    const office = $("office").value;
    const values = {
      office_id: office ? Number(office) : null,
      work_calendar_id: $("work-id").value.trim(),
      holiday_calendar_id: $("holiday-id").value.trim(),
      split_day_events: $("split-day").checked,
    };
    $("save").disabled = true;
    $("go-input").classList.add("hidden");
    try {
      if (!values.office_id) throw new Error("1. で区所を選んでください。");
      if (!values.work_calendar_id) throw new Error("勤務用のカレンダーIDを入力してください。");
      message("result", "保存しています…");
      await saveSettings(values);
      message("result", "接続テスト中です(10秒ほどかかることがあります)…");
      await callFunction("verify-calendar");
      settings.verified_at = new Date().toISOString();
      message("result", "接続できました。勤務入力に進めます。", "ok");
      updateGoInput();
    } catch (err) {
      message("result", err.message || String(err), "error");
    } finally {
      $("save").disabled = false;
    }
  });

  // PINの欄に形の違う値が自動で入って消したとき(app.js の bindDigitsOnly)
  ["pin-current", "pin-new", "pin-new2"].forEach((id) => {
    $(id).addEventListener("digits-rejected", () => message("pin-result", AUTOFILL_HINT, "error"));
    if ($(id).dataset.rejected) message("pin-result", AUTOFILL_HINT, "error");
  });

  $("pin-save").addEventListener("click", async () => {
    const current = toHalfWidth($("pin-current").value);
    const next = toHalfWidth($("pin-new").value);
    if (!/^\d{4}$/.test(next)) return message("pin-result", "新しいPINは4桁の数字で入力してください。", "error");
    if (next !== toHalfWidth($("pin-new2").value)) return message("pin-result", "新しいPINが2回で一致しません。", "error");
    $("pin-save").disabled = true;
    try {
      const result = await callFunction("change-pin", { current_pin: current, new_pin: next });
      // PINは変わったが、新しいPINで入り直せなかった(混雑など)。この端末のログインも消されたので、ログインし直してもらう
      if (!result.session) {
        await loginLost("PINを変更しました。新しいPINで、もう一度ログインしてください。");
        return;
      }
      // この端末は、新しいPINでのログインに入れ替える(前のログインは、ほかの端末の分と一緒に消されたため)
      await startSession(result.session);
      ["pin-current", "pin-new", "pin-new2"].forEach((id) => ($(id).value = ""));
      message("pin-result", "PINを変更しました。次のログインから新しいPINを使ってください。" +
        (result.sessionsCleared === true ? "ほかの端末でログインしていた分は、ログアウトしました。"
          : result.sessionsCleared === false ? "(ほかの端末のログインは消せませんでした。管理者に連絡してください)" : ""), "ok");
    } catch (err) {
      message("pin-result", err.message || String(err), "error");
    } finally {
      $("pin-save").disabled = false;
    }
  });
}

main().catch((err) => message("result", err.message || String(err), "error"));
