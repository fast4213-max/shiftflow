import { $, callFunction, copyText, requireLogin, supabase } from "./app.js";

let session = null;
let settings = null; // user_settings の行(無ければ null)

function showResult(text, kind) {
  $("result").textContent = text;
  $("result").className = kind || "";
}

function updateGoInput() {
  const ready = settings && settings.verified_at && settings.office_id;
  $("go-input").classList.toggle("hidden", !ready);
}

// 利用者が書けるのはカレンダーIDと区所の列だけ(検証済みフラグは Edge Function が書く)
async function saveSettings(values) {
  const { data, error } = settings
    ? await supabase.from("user_settings").update(values).eq("user_id", session.user.id)
      .select("work_calendar_id, holiday_calendar_id, verified_at, office_id").single()
    : await supabase.from("user_settings").insert({ user_id: session.user.id, ...values })
      .select("work_calendar_id, holiday_calendar_id, verified_at, office_id").single();
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

  if (settings) {
    $("work-id").value = settings.work_calendar_id || "";
    $("holiday-id").value = settings.holiday_calendar_id || "";
  }
  if (!settings || !settings.verified_at || !settings.office_id) $("first-time").classList.remove("hidden");
  if (settings && settings.verified_at) showResult("接続テスト済みです。", "ok");
  updateGoInput();

  loadOffices().catch((err) => ($("office-result").textContent = err.message));
  $("office").addEventListener("change", async () => {
    const value = $("office").value;
    $("office-result").textContent = "保存しています…";
    $("office-result").className = "muted";
    try {
      await saveSettings({ office_id: value ? Number(value) : null });
      $("office-result").textContent = value ? "保存しました。" : "";
      $("office-result").className = "ok";
      updateGoInput();
    } catch (err) {
      $("office-result").textContent = err.message || String(err);
      $("office-result").className = "error";
    }
  });

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
    const values = {
      work_calendar_id: $("work-id").value.trim(),
      holiday_calendar_id: $("holiday-id").value.trim(),
    };
    $("verify").disabled = true;
    $("go-input").classList.add("hidden");
    try {
      if (!values.work_calendar_id || !values.holiday_calendar_id) {
        throw new Error("勤務用と休日用の両方のカレンダーIDを入力してください。");
      }
      showResult("保存しています…");
      await saveSettings(values);
      showResult("接続テスト中です(10秒ほどかかることがあります)…");
      await callFunction("verify-calendar");
      settings.verified_at = new Date().toISOString();
      showResult(settings.office_id ? "接続できました。勤務入力に進めます。" : "接続できました。上で区所を選ぶと勤務入力に進めます。", "ok");
      updateGoInput();
    } catch (err) {
      showResult(err.message || String(err), "error");
    } finally {
      $("verify").disabled = false;
    }
  });
}

main().catch((err) => showResult(err.message || String(err), "error"));
