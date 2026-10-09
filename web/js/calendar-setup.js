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

const LOAD_ERROR = "Google のログイン部品を読み込めませんでした。電波の良いところで、もう一度お試しください。広告ブロックを使っているときは、このサイトではオフにしてください。";
const TOKEN_TIMEOUT_MS = 3 * 60 * 1000;
const CONFIRM_MS = 30 * 1000;

// Google のログイン部品は、ページを開いたときに読み込んでおく
// (ボタンを押してから読むと、押した操作が切れて、許可の画面がブロックされることがあるため)
let client = null; // 許可を取る部品(読み込めたら1回だけ作る)
let loadState = "idle"; // idle | loading | ready | failed
let pending = null; // 許可待ちの { resolve, reject, timer }

function settlePending(fn, value) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  p[fn](value);
}

function makeClient() {
  client = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (res) => {
      if (res.error) {
        settlePending("reject", new Error(res.error === "access_denied"
          ? "許可されませんでした。もう一度ボタンを押して、Google の画面で「次へ」(許可)を選んでください。"
          : "Google の許可を受けられませんでした(" + (res.error_description || res.error) + ")。もう一度お試しください。"));
      } else if (typeof window.google.accounts.oauth2.hasGrantedAllScopes === "function" && !window.google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) {
        settlePending("reject", new Error("許可されませんでした。もう一度ボタンを押して、Google の画面で「次へ」(許可)を選んでください。"));
      } else {
        settlePending("resolve", res.access_token);
      }
    },
    error_callback: (err) => {
      const type = err && err.type;
      settlePending("reject", new Error(type === "popup_failed_to_open"
        ? "Google の画面を開けませんでした。ポップアップがブロックされています。このサイトでポップアップを許可するか、Safari / Chrome でこのページを開いて、もう一度お試しください。"
        : type === "popup_closed"
          ? "Google の画面が閉じられました。もう一度お試しください。"
          : "Google の許可を受けられませんでした" + (type ? `(${type})` : "") + "。もう一度お試しください。"));
    },
  });
}

function startLoading() {
  if (loadState === "loading" || loadState === "ready") return;
  const ready = () => { try { makeClient(); loadState = "ready"; } catch { loadState = "failed"; } };
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return ready();
  loadState = "loading";
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.onload = ready;
  s.onerror = () => { loadState = "failed"; s.remove(); };
  document.head.appendChild(s);
}

// ボタンを押した操作の中で、すぐに呼ぶ(この前に await を入れない)
function requestToken() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settlePending("reject", new Error("Google の許可が3分間ありませんでした。もう一度ボタンを押してください。")), TOKEN_TIMEOUT_MS);
    pending = { resolve, reject, timer };
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

function addShareLink(text, id) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = shareUrl(id);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
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

// saveIds(values): 作ったカレンダーのIDを、すぐ保存する(settings.js が渡す)
export function initCalendarSetup({ saveIds } = {}) {
  if (!GOOGLE_CLIENT_ID) return;
  $("auto-setup").classList.remove("hidden");
  startLoading();

  // ホーム画面に入れたアプリとして開いているときは、Google の画面から戻れないことがある
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  if (standalone && $("auto-standalone")) $("auto-standalone").classList.remove("hidden");

  // 勤務用のIDがもう入っている人は、勤務用はそのままにして、休日用・非番の時間用だけを後から作れる
  // 選択は、画面を開いたときと、利用者がIDの欄を書き換えたときに出し入れする
  // (かんたん設定で作った直後に、画面が切り替わって分かりにくくならないように)
  const keepWork = () => !$("auto-work-row").classList.contains("hidden") && !!$("work-id").value.trim() && $("auto-work").value === "keep";
  const toggleWorkRow = () => $("auto-work-row").classList.toggle("hidden", !$("work-id").value.trim());
  let keepBefore = null;
  const toggleNames = () => {
    const keep = keepWork();
    $("auto-work-name-row").classList.toggle("hidden", keep);
    // 休日の「今のまま」は、勤務用をそのまま使うときだけ選べる(切り替えたときは、それぞれのふだんの値にする)
    // (iPhone の Safari は option の hidden が効かないので、足し引きする)
    if (keep !== keepBefore) {
      const select = $("auto-holiday");
      const old = select.querySelector('option[value="keep"]');
      if (keep && !old) {
        const opt = document.createElement("option");
        opt.value = "keep";
        opt.textContent = "今のまま(変えない)";
        select.appendChild(opt);
        select.value = "keep";
      } else if (!keep && old) {
        if (select.value === "keep") select.value = "own";
        old.remove();
      }
      keepBefore = keep;
    }
    $("auto-holiday-name-row").classList.toggle("hidden", $("auto-holiday").value !== "own");
    $("auto-offduty-name-row").classList.toggle("hidden", !$("auto-offduty").checked);
  };
  $("auto-work").addEventListener("change", toggleNames);
  $("work-id").addEventListener("input", (e) => { if (e.isTrusted) { toggleWorkRow(); toggleNames(); } });
  $("auto-holiday").addEventListener("change", toggleNames);
  $("auto-offduty").addEventListener("change", toggleNames);
  toggleWorkRow();
  toggleNames();

  const result = (text, kind) => {
    $("auto-result").textContent = friendlyText(text) || "";
    $("auto-result").className = "message" + (kind ? " " + kind : "");
  };

  let confirmAt = 0; // 入れ替えの確認で、1回目に押した時刻
  $("auto-run").addEventListener("click", async () => {
    const serviceEmail = $("sa-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(serviceEmail)) return result("登録用アドレスを読み込めていません。少し待って、もう一度お試しください。", "error");
    if (loadState !== "ready") {
      if (loadState === "failed") { startLoading(); return result(LOAD_ERROR, "error"); }
      return result("準備中です。数秒待って、もう一度押してください。", "error");
    }
    const keep = keepWork();
    const current = { work: $("work-id").value.trim(), holiday: $("holiday-id").value.trim(), offduty: $("offduty-id").value.trim() };
    const holiday = $("auto-holiday").value; // own | work | none | keep(勤務用をそのまま使うときだけ)
    const wantOffduty = $("auto-offduty").checked;
    if (keep && holiday !== "own" && !wantOffduty) {
      return result("作るカレンダーがありません。休日の予定を「休日用のカレンダーを別に作る」にするか、「非番の時間用のカレンダーも作る」にチェックを入れてください。", "error");
    }
    // 入れ替えるときは、もう一度押してもらう(確認のダイアログを出すと、押した操作が切れて、許可の画面がブロックされることがあるため)
    if (!keep && current.work && Date.now() - confirmAt > CONFIRM_MS) {
      confirmAt = Date.now();
      return result("すでにカレンダーIDが入っています。新しいカレンダーを作って入れ替えるときは、30秒以内に、もう一度ボタンを押してください(前のカレンダーは、Googleカレンダーに残ります)。", "error");
    }
    confirmAt = 0;

    $("auto-run").disabled = true;
    $("auto-links").innerHTML = "";
    let token = "";
    const created = []; // 作れたカレンダー { key, name, id }
    const failed = []; // 作れなかった(作ろうとした)カレンダーの名前
    let failure = null;
    // 作る予定のもの(名前は押した時点のものを使う)
    const plan = keep ? [] : [{ key: "work", label: "勤務用", name: nameOf("auto-work-name", "勤務") }];
    if (holiday === "own") plan.push({ key: "holiday", label: "休日用", name: nameOf("auto-holiday-name", "休日") });
    if (wantOffduty) plan.push({ key: "offduty", label: "非番の時間用", name: nameOf("auto-offduty-name", "非番の時間") });
    try {
      result("Google の画面で、許可をしてください…");
      token = await requestToken(); // requestAccessToken は、この前に await を挟まず呼ぶ

      for (const item of plan) {
        result(`${item.label}のカレンダーを作っています…`);
        try {
          const id = await createCalendar(token, item.name);
          created.push({ ...item, id });
          addShareLink(`「${item.name}」の共有を開く`, id);
        } catch (err) {
          failure = err;
          break;
        }
      }
    } catch (err) {
      failure = err; // 許可が取れなかった(何も作っていない)
    } finally {
      // 許可は、ここで使い終わり。取り消しておく(サーバーには送っていない)
      if (token) { try { window.google.accounts.oauth2.revoke(token); } catch { /* 取り消せなくても影響なし */ } }
    }

    try {
      const idOf = (key) => (created.find((c) => c.key === key) || {}).id || "";
      if (failure) plan.filter((p) => !idOf(p.key)).forEach((p) => failed.push(`「${p.name}」`));
      if (!created.length) return result(failure ? failure.message || String(failure) : "カレンダーを作れませんでした。", "error");

      // 入力欄は、最後にまとめて変える(途中で失敗しても、新旧のIDが混ざらないように)。
      // 勤務用をそのまま使うときは、作らなかったもの・作れなかったものは今のIDのまま
      const workId = keep ? current.work : idOf("work");
      const made = (key) => idOf(key) || (keep ? current[key] : "");
      const values = {
        work_calendar_id: workId,
        holiday_calendar_id: holiday === "own" ? made("holiday") : holiday === "work" ? workId : holiday === "keep" ? current.holiday : "",
        offduty_calendar_id: wantOffduty ? made("offduty") : keep ? current.offduty : "",
      };
      setValue("work-id", values.work_calendar_id);
      setValue("holiday-id", values.holiday_calendar_id);
      setValue("offduty-id", values.offduty_calendar_id);
      const offdutyMade = !!idOf("offduty");
      if (offdutyMade) {
        $("split-offduty").checked = true;
        $("split-offduty").dispatchEvent(new Event("change", { bubbles: true }));
        values.split_offduty_events = true;
      }

      // 作ったIDは、すぐ保存する(共有のためにアプリを切り替えて、画面が読み込み直されても消えないように)
      let saved = true;
      if (saveIds) { try { await saveIds(values); } catch { saved = false; } }

      const names = created.map((c) => `「${c.name}」`).join("");
      const extra = offdutyMade ? "「非番を2件で登録する」もオンにしました。" : "";
      // いくつ共有するかが分かるように、数と名前を出す(X3)
      const share = `次に、作った${created.length}つのカレンダー(${names})を、1つずつ登録用アドレスと共有してください。` +
        "スマホは、Googleカレンダーのアプリの「≡」→「設定」→カレンダー名→「共有する相手」から行います(下の「共有を開く」は、スマホではブラウザが開くことがあります。そのときは、ブラウザは使わず、Googleカレンダーのアプリを開いて共有してください。" +
        "パソコンで別のGoogleアカウントの画面が開いたときは、右上で、カレンダーを作ったアカウントに切り替えてください)。";
      const after = saved ? "共有できたら、このページに戻り、1. で区所を選んで「保存して接続テスト」を押してください。"
        : "IDを保存できませんでした。共有できたら、このページに戻り、1. で区所を選んで「保存して接続テスト」を押してください(その前にこのページを閉じたときは、IDがなくなるので、もう一度作ってください)。";
      // 前からIDがあった人: 新しいカレンダーには、登録済みの月の予定がまだ入っていない。入れ替えた前のカレンダーの予定は残る(X1)
      const used = new Set([values.work_calendar_id, values.holiday_calendar_id, values.offduty_calendar_id]);
      const replaced = [...new Set([current.work, current.holiday, current.offduty])].filter((id) => id && !used.has(id));
      const redo = current.work
        ? "\n接続できたら、すでに登録した月は、勤務入力でもう一度「登録」してください(新しいカレンダーには、まだ予定が入っていません)。" +
          (replaced.length ? "入れ替えた前のカレンダーの予定は、そのまま残ります。いらなければ、前のカレンダーを削除してください(カレンダーごと消せるのは、ブラウザの「PC表示」のGoogleカレンダーだけで、スマホのアプリからは消せません。下の「前のカレンダーの設定を開く」から、一番下の「カレンダーを削除」へ進めます。先に勤務入力の「リセット」で予定だけ消すこともできます)。" : "")
        : "";
      // 前のカレンダーの設定画面へのリンク(削除はその画面の一番下)
      replaced.forEach((id, i) => {
        try { addShareLink(`前のカレンダーの設定を開く${replaced.length > 1 ? `(${i + 1})` : ""}`, id); } catch { /* 開けない形のIDはリンクを出さない */ }
      });
      if (failure) {
        result(`途中で失敗しました: ${failure.message || failure}\n作れたもの: ${names}\n作れなかったもの: ${failed.join("")}\n${keep ? "作れなかったものの欄は、今のIDのままです。" : "作れなかったものの欄は空にしました。"}${saved ? "作れたもののIDは保存しました。" : ""}もう一度ボタンを押すと、作れたものが重複します。重複したカレンダーは、Googleカレンダーで消せます。\n${share}${after}${redo}`, "error");
      } else {
        result(`カレンダーを作って、IDを下の欄に入れました${saved ? "(保存もしました)" : ""}。${extra}${share}${after}${redo}`, saved ? "ok" : "error");
      }
      // 「そのまま使う」で作ったあとは、作るものを外しておく(続けて押しても、同じカレンダーが重複して作られないように。X2)
      if (keep) {
        $("auto-holiday").value = "keep";
        $("auto-offduty").checked = false;
        toggleNames();
      }
    } finally {
      $("auto-run").disabled = false;
    }
  });
}
