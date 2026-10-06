// お知らせ(ログイン後)。いま表示中のお知らせを全部出し、見た印をこの端末に残す(メニューの赤い点が消える)
import { $, fetchNotices, markNoticesSeen, noticeElement, requireLogin, unseenNotices } from "./app.js?v=dev";

function setMessage(text, kind) {
  $("message").textContent = text || "";
  $("message").className = "message" + (kind ? " " + kind : "");
}

async function main() {
  const ctx = await requireLogin("notices.html");
  if (!ctx) return;
  const list = await fetchNotices();
  const unseen = new Set(unseenNotices(list).map((n) => n.id));
  const box = $("notices");
  box.innerHTML = "";
  list.forEach((n) => {
    const card = document.createElement("div");
    card.className = "card";
    card.appendChild(noticeElement(n, { isNew: unseen.has(n.id) }));
    box.appendChild(card);
  });
  setMessage(list.length ? "" : "いまお知らせはありません(読み込めなかったときは、ページを読み直してください)。");
  markNoticesSeen(list);
}

main().catch((err) => setMessage(err.message || String(err), "error"));
