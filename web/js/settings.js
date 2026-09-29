import { $, callFunction, copyText, requireLogin, supabase } from "./app.js";

function showResult(text, kind) {
  $("result").textContent = text;
  $("result").className = kind || "";
}

async function saveIds(session, current) {
  const values = {
    work_calendar_id: $("work-id").value.trim(),
    holiday_calendar_id: $("holiday-id").value.trim(),
  };
  if (!values.work_calendar_id || !values.holiday_calendar_id) {
    throw new Error("勤務用と休日用の両方のカレンダーIDを入力してください。");
  }
  // 利用者が書けるのはカレンダーIDの列だけ(検証済みフラグは Edge Function が書く)
  const { error } = current
    ? await supabase.from("user_settings").update(values).eq("user_id", session.user.id)
    : await supabase.from("user_settings").insert({ user_id: session.user.id, ...values });
  if (error) throw error;
}

async function main() {
  const ctx = await requireLogin("settings.html");
  if (!ctx) return;
  let settings = ctx.settings;

  if (settings) {
    $("work-id").value = settings.work_calendar_id || "";
    $("holiday-id").value = settings.holiday_calendar_id || "";
  }
  if (!settings || !settings.verified_at) $("first-time").classList.remove("hidden");
  if (settings && settings.verified_at) {
    showResult("接続テスト済みです。", "ok");
    $("go-input").classList.remove("hidden");
  }

  callFunction("app-config")
    .then((config) => ($("sa-email").value = config.serviceAccountEmail))
    .catch((err) => ($("sa-email").value = "取得できませんでした: " + err.message));
  $("copy-sa").addEventListener("click", () => copyText($("sa-email").value, $("copy-sa")));

  // IDを書き換えたら、テスト済みの表示を消す
  ["work-id", "holiday-id"].forEach((id) =>
    $(id).addEventListener("input", () => {
      showResult("");
      $("go-input").classList.add("hidden");
    })
  );

  $("verify").addEventListener("click", async () => {
    $("verify").disabled = true;
    $("go-input").classList.add("hidden");
    showResult("保存しています…");
    try {
      await saveIds(ctx.session, settings);
      settings = settings || {};
      showResult("接続テスト中です(10秒ほどかかることがあります)…");
      await callFunction("verify-calendar");
      showResult("接続できました。勤務入力に進めます。", "ok");
      $("go-input").classList.remove("hidden");
    } catch (err) {
      showResult(err.message || String(err), "error");
      $("go-input").classList.add("hidden");
    } finally {
      $("verify").disabled = false;
    }
  });
}

main().catch((err) => showResult(err.message || String(err), "error"));
