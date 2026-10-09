// 設定画面の「Googleでカレンダーを自動で作る」。
// 利用者の Google アカウントで、このアプリ用のカレンダーを新しく作り、登録用アドレス(サービスアカウント)と共有する。
// 権限は calendar.app.created だけ(アプリが作ったカレンダーの中だけを触れる。メインのカレンダーは触れない)。
// 取った許可(アクセストークン)はこの画面の中だけで使い、サーバーには送らず、終わったら取り消す。
import { GOOGLE_CLIENT_ID } from "./config.js?v=dev";
import { friendlyText, $ } from "./app.js?v=dev";

const SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const API = "https://www.googleapis.com/calendar/v3";
const NAME_MAX = 30;

function loadGoogleScript() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google のログイン部品を読み込めませんでした。電波の良いところで、もう一度お試しください。広告ブロックを使っているときは、このサイトではオフにしてください。"));
    document.head.appendChild(s);
  });
}

function requestToken() {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (res) => (res.error ? reject(new Error(res.error_description || res.error)) : resolve(res.access_token)),
      error_callback: (err) => reject(new Error(err && err.type === "popup_closed" ? "Google の画面が閉じられました。もう一度お試しください。" : "Google の許可を受けられませんでした。")),
    });
    client.requestAccessToken();
  });
}

async function googleApi(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error.message || ""; } catch { /* 本文なし */ }
    throw new Error(`Google のカレンダーの操作に失敗しました(${res.status}${detail ? ": " + detail : ""})。`);
  }
  return res.json();
}

// どこで失敗したかが分かるよう、段階の名前をエラーに付ける
async function withStep(step, fn) {
  try {
    return await fn();
  } catch (err) {
    err.message = `「${step}」で失敗: ${err.message}`;
    throw err;
  }
}

// 新しいカレンダーを作り、登録用アドレスに「予定の変更権限」で共有して、ID を返す
async function createShared(token, name, serviceEmail) {
  const cal = await withStep("カレンダーを作る", () => googleApi(token, "POST", "/calendars", { summary: name, timeZone: "Asia/Tokyo" }));
  // 共有の途中で失敗したときも、作れたカレンダーのIDを持ち帰れるよう、エラーにIDを付ける
  try {
    await withStep("登録用アドレスと共有する", () => googleApi(token, "POST", `/calendars/${encodeURIComponent(cal.id)}/acl?sendNotifications=false`, {
      role: "writer",
      scope: { type: "user", value: serviceEmail },
    }));
  } catch (err) {
    err.message += `(カレンダー「${name}」は作られています。Googleカレンダーで確認してください)`;
    throw err;
  }
  return cal.id;
}

function setValue(id, value) {
  const el = $(id);
  el.value = value;
  // settings.js が「保存するまで接続テスト済みの表示を消す」ために見ている
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function nameOf(id, fallback) {
  const name = $(id).value.trim().slice(0, NAME_MAX);
  return name || fallback;
}

export function initCalendarSetup() {
  if (!GOOGLE_CLIENT_ID) return;
  // 試験のあいだは、URL の最後に ?beta=1 を付けた人にだけ出す(ふつうの利用者には今までの画面のまま)
  if (new URLSearchParams(location.search).get("beta") !== "1") return;
  $("auto-setup").classList.remove("hidden");

  const toggleNames = () => {
    $("auto-holiday-name-row").classList.toggle("hidden", $("auto-holiday").value !== "own");
    $("auto-offduty-name-row").classList.toggle("hidden", !$("auto-offduty").checked);
  };
  $("auto-holiday").addEventListener("change", toggleNames);
  $("auto-offduty").addEventListener("change", toggleNames);
  toggleNames();

  const result = (text, kind) => {
    $("auto-result").textContent = friendlyText(text) || "";
    $("auto-result").className = "message" + (kind ? " " + kind : "");
  };

  $("auto-run").addEventListener("click", async () => {
    const serviceEmail = $("sa-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(serviceEmail)) return result("登録用アドレスを読み込めていません。少し待って、もう一度お試しください。", "error");
    if ($("work-id").value.trim() && !confirm("すでにカレンダーIDが入っています。新しいカレンダーを作って、入れ替えますか?\n(前のカレンダーは、Googleカレンダーに残ります)")) return;

    const holiday = $("auto-holiday").value; // own | work | none
    $("auto-run").disabled = true;
    let token = "";
    try {
      result("Google の画面で、許可をしてください…");
      await loadGoogleScript();
      token = await requestToken();

      result("勤務用のカレンダーを作っています…");
      const workId = await createShared(token, nameOf("auto-work-name", "勤務"), serviceEmail);
      setValue("work-id", workId);

      if (holiday === "own") {
        result("休日用のカレンダーを作っています…");
        setValue("holiday-id", await createShared(token, nameOf("auto-holiday-name", "休日"), serviceEmail));
      } else {
        setValue("holiday-id", holiday === "work" ? workId : "");
      }
      if ($("auto-offduty").checked) {
        result("非番の時間用のカレンダーを作っています…");
        setValue("offduty-id", await createShared(token, nameOf("auto-offduty-name", "非番の時間"), serviceEmail));
      }
      result("カレンダーを作って、共有しました。下の「保存して接続テスト」を押してください。", "ok");
    } catch (err) {
      // 途中まで作れたカレンダーのIDは、下の欄に入っている。作り直すと重複するので、そのまま保存するか、Google カレンダーで消す
      const done = $("work-id").value.trim() ? "(作れたぶんのIDは、下の欄に入っています。足りないものは、もう一度ボタンを押す前に、Googleカレンダーで確認してください)" : "";
      result((err.message || String(err)) + done, "error");
    } finally {
      // 許可は、ここで使い終わり。取り消しておく(サーバーには送っていない)
      if (token) { try { window.google.accounts.oauth2.revoke(token); } catch { /* 取り消せなくても影響なし */ } }
      $("auto-run").disabled = false;
    }
  });
}
