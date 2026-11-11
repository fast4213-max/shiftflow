// お知らせ(ログイン後)。いま表示中のお知らせを全部出し、見た印をこの端末に残す(メニューの赤い点が消える)。
// いちばん上の「あなたへのお知らせ」は、自分あてのカレンダーの共有のお誘い(docs/share/DESIGN.md)。返事をするまで残る
import { friendlyText, $, fetchNotices, markNoticesSeen, noticeElement, requireLogin, unseenNotices } from "./app.js?v=dev";
import { fetchShare, receivedAction, receivedHtml } from "./share.js?v=dev";

function mineMessage(text, kind) {
  $("mine-msg").textContent = friendlyText(text) || "";
  $("mine-msg").className = "message" + (kind ? " " + kind : "");
}

// 自分あてのお誘い。読めないときは出さない(全員向けのお知らせは、そのまま出す)
async function showMine() {
  let share;
  try { share = await fetchShare(); } catch (_) { return; }
  const box = $("mine");
  const list = share.received;
  if (!list.length && !$("mine-msg").textContent) { box.hidden = true; return; }
  box.hidden = false;
  $("mine-list").innerHTML = list.length ? receivedHtml(list) : "";
}

$("mine-list").addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-share]");
  if (!el) return;
  el.disabled = true;
  try {
    const text = await receivedAction(el, $("mine-list"));
    if (text) mineMessage(text, "ok");
    await showMine();
  } catch (err) {
    mineMessage(err.message || String(err), "error");
  } finally {
    el.disabled = false;
  }
});

function setMessage(text, kind) {
  $("message").textContent = friendlyText(text) || "";
  $("message").className = "message" + (kind ? " " + kind : "");
}

async function main() {
  const ctx = await requireLogin("notices.html");
  if (!ctx) return;
  showMine();
  const list = await fetchNotices();
  if (list === null) {
    // 読めなかったときは、「見た記録」を触らない(空で上書きすると、見たお知らせの赤い点と NEW が戻る)
    return setMessage("お知らせを読み込めませんでした。電波の良いところで、ページを読み直してください。", "error");
  }
  const unseen = new Set(unseenNotices(list).map((n) => n.id));
  const box = $("notices");
  box.innerHTML = "";
  list.forEach((n) => {
    const card = document.createElement("div");
    card.className = "card";
    card.appendChild(noticeElement(n, { isNew: unseen.has(n.id) }));
    box.appendChild(card);
  });
  setMessage(list.length ? "" : "いまお知らせはありません。");
  markNoticesSeen(list);
}

main().catch((err) => setMessage(err.message || String(err), "error"));
