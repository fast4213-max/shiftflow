// お知らせ(ログイン後)。いま表示中のお知らせを全部出し、見た印をこの端末に残す(メニューの赤い点が消える)
import { friendlyText, $, fetchNotices, markNoticesSeen, noticeElement, requireLogin, unseenNotices } from "./app.js?v=dev";

function setMessage(text, kind) {
  $("message").textContent = friendlyText(text) || "";
  $("message").className = "message" + (kind ? " " + kind : "");
}

async function main() {
  const ctx = await requireLogin("notices.html");
  if (!ctx) return;
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
