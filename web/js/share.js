// カレンダーの共有(docs/share/DESIGN.md)。お知らせの画面(notices.js)と、カレンダーの設定(calendar/cal-main.js)の両方で使う。
// 読み書きは、すべて SQL の関数(cal_share_*)。社員番号から人を探すのも、サーバーの中だけ
import { friendlyText, supabase } from "./app.js?v=dev";
export { fetchShareInboxCount } from "./app.js?v=dev";

export const SHARE_MAX = 5;
// 見せる範囲(選ぶ順)
export const SCOPES = [["duty", "勤務だけ"], ["duty_off", "勤務と休日"], ["none", "見せない"]];
export const scopeText = (s) => ({ duty: "勤務だけ", duty_off: "勤務と休日", none: "見せない" }[s] || "");
export const kindText = (k) => (k === "couple" ? "夫婦" : "仲間");
export const mdText = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`; };

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function shareRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(friendlyText(error.message));
  return data;
}

// 共有の一覧 { links, views, sent, received }
export async function fetchShare() {
  const d = await shareRpc("cal_share_list");
  return { links: d?.links || [], views: d?.views || [], sent: d?.sent || [], received: d?.received || [] };
}

function scopeRadios(name, checked) {
  return SCOPES.map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}"${v === checked ? " checked" : ""}><span>${t}</span></label>`).join("");
}
export function scopeSeg(name, checked) { return `<div class="seg" role="radiogroup">${scopeRadios(name, checked)}</div>`; }

// 届いているお誘い(お知らせ・カレンダーの設定)。押したボタンは data-share="accept|decline" data-id
export function receivedHtml(list) {
  return list.map((r) => `<div class="share-inv" data-inv="${escHtml(r.id)}">
    <p><b>🔔 ${escHtml(r.from_name)}さん</b> から、カレンダーの共有(${kindText(r.kind)})のお誘いです。</p>
    <p class="sub muted">${escHtml(r.from_name)}さんが見せる範囲: <b>${escHtml(scopeText(r.from_scope))}</b>(${escHtml(mdText(r.expires_at))}まで)</p>
    <p class="sub muted">あなたの勤務を見せる範囲:</p>
    ${scopeSeg(`inv-sc-${escHtml(r.id)}`, "duty")}
    <div class="btns"><button class="btn pri primary" type="button" data-share="accept" data-id="${escHtml(r.id)}">共有する</button><button class="btn" type="button" data-share="decline" data-id="${escHtml(r.id)}">断る</button></div>
  </div>`).join("");
}

// 「共有する」「断る」を押したとき。終わったら、画面に出す文を返す(失敗は Error)
export async function receivedAction(el, root) {
  const id = el.dataset.id;
  if (el.dataset.share === "accept") {
    const picked = root.querySelector(`input[name="inv-sc-${CSS.escape(id)}"]:checked`);
    await shareRpc("cal_share_accept", { p_invite: id, p_scope: picked ? picked.value : "duty" });
    return "共有しました。カレンダーに、相手の名前のラベルで勤務が出ます(相手が見せている範囲だけ)。";
  }
  if (!window.confirm("このお誘いを断りますか？")) return "";
  await shareRpc("cal_share_decline", { p_invite: id });
  return "断りました。";
}
