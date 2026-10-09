// 設定画面の「Googleでカレンダーを自動で作る」。
// 利用者の Google アカウントで、このアプリ用のカレンダーを新しく作り、そのIDを入力欄に入れる。
// 権限は calendar.app.created だけ(アプリが作ったカレンダーの中だけを触れる。メインのカレンダーは触れない)。
// この権限では、登録用アドレス(サービスアカウント)との共有はできない(403)ので、共有は利用者が画面で行う。
// 共有の画面へ直接行くリンクを出す。
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

// 新しいカレンダーを作って、ID を返す
async function createCalendar(token, name) {
  try {
    const cal = await googleApi(token, "POST", "/calendars", { summary: name, timeZone: "Asia/Tokyo" });
    return cal.id;
  } catch (err) {
    err.message = `「カレンダーを作る」で失敗: ${err.message}`;
    throw err;
  }
}

// そのカレンダーの「設定と共有」の画面へのリンク(共有する相手を足す画面)
function shareUrl(id) {
  return "https://calendar.google.com/calendar/u/0/r/settings/calendar/" + btoa(id).replace(/=+$/, "");
}

function addShareLink(name, id) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = shareUrl(id);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `「${name}」の共有を開く`;
  li.appendChild(a);
  $("auto-links").appendChild(li);
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
    $("auto-links").innerHTML = "";
    let token = "";
    try {
      result("Google の画面で、許可をしてください…");
      await loadGoogleScript();
      token = await requestToken();

      result("勤務用のカレンダーを作っています…");
      const workName = nameOf("auto-work-name", "勤務");
      const workId = await createCalendar(token, workName);
      setValue("work-id", workId);
      addShareLink(workName, workId);

      if (holiday === "own") {
        result("休日用のカレンダーを作っています…");
        const name = nameOf("auto-holiday-name", "休日");
        const id = await createCalendar(token, name);
        setValue("holiday-id", id);
        addShareLink(name, id);
      } else {
        setValue("holiday-id", holiday === "work" ? workId : "");
      }
      if ($("auto-offduty").checked) {
        result("非番の時間用のカレンダーを作っています…");
        const name = nameOf("auto-offduty-name", "非番の時間");
        const id = await createCalendar(token, name);
        setValue("offduty-id", id);
        addShareLink(name, id);
      }
      result("カレンダーを作って、IDを下の欄に入れました。次に、作ったカレンダーを登録用アドレスと共有してください。スマホは、Googleカレンダーのアプリの「≡」→「設定」→カレンダー名→「共有する相手」から行います(下の「共有を開く」のリンクは、スマホでは、アプリではなくブラウザが開くことがあります。ブラウザが開いたときは、そのまま「PC表示」にして進めるか、アプリを開いて共有してください)。", "ok");
    } catch (err) {
      // 途中まで作れたカレンダーのIDは、下の欄に入っている。作り直すと重複するので、そのまま保存するか、Google カレンダーで消す
      const done = $("work-id").value.trim() ? "(作れたぶんのIDは、下の欄に入っています。足りないものは、もう一度ボタンを押す前に、Googleカレンダーで確認してください。作ったカレンダーが重複したときは、Googleカレンダーで消せます)" : "";
      result((err.message || String(err)) + done, "error");
    } finally {
      // 許可は、ここで使い終わり。取り消しておく(サーバーには送っていない)
      if (token) { try { window.google.accounts.oauth2.revoke(token); } catch { /* 取り消せなくても影響なし */ } }
      $("auto-run").disabled = false;
    }
  });
}
