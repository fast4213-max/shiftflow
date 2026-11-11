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
// 夫婦のお誘いは、相手のカレンダーを2人で使うことの説明と、今の自分の予定などを「取り込む/取り込まない」を出す
export function receivedHtml(list) {
  return list.map((r) => {
    const id = escHtml(r.id);
    const couple = r.kind === "couple" ? `
    <p class="sub muted"><b>${escHtml(r.from_name)}さんのカレンダーを、2人で一緒に使います。</b>予定・TODO・重要メモ・スタンプ・画像・予定の写真は、2人とも見られて、直せます(「自分だけ」にしたラベルの予定は除きます)。あなたのカレンダーにあるものは、一緒に使うあいだは隠れます(消えません)。共有をやめると、あなたが作ったものは、あなたのカレンダーに戻ります。</p>
    <p class="sub muted">今のあなたの予定・TODOなど:</p>
    <div class="seg" role="radiogroup"><label><input type="radio" name="inv-imp-${id}" value="no" checked><span>取り込まない</span></label><label><input type="radio" name="inv-imp-${id}" value="yes"><span>取り込む</span></label></div>
    <p class="sub muted">取り込むと、今のあなたの予定・TODO・重要メモ・テンプレート・画像・スタンプを、2人のカレンダーに移します(やめると、あなたのカレンダーに戻ります)。</p>` : "";
    return `<div class="share-inv" data-inv="${id}">
    <p><b>🔔 ${escHtml(r.from_name)}さん</b> から、カレンダーの共有(${kindText(r.kind)})のお誘いです。</p>
    <p class="sub muted">${escHtml(r.from_name)}さんが見せる勤務の範囲: <b>${escHtml(scopeText(r.from_scope))}</b>(${escHtml(mdText(r.expires_at))}まで)</p>${couple}
    <p class="sub muted">あなたの勤務を見せる範囲:</p>
    ${scopeSeg(`inv-sc-${id}`, r.kind === "couple" ? "duty_off" : "duty")}
    <div class="btns"><button class="btn pri primary" type="button" data-share="accept" data-id="${id}" data-kind="${escHtml(r.kind)}">共有する</button><button class="btn" type="button" data-share="decline" data-id="${id}">断る</button></div>
  </div>`;
  }).join("");
}

// 「共有する」「断る」を押したとき。終わったら、画面に出す文を返す(失敗は Error)
export async function receivedAction(el, root) {
  const id = el.dataset.id;
  if (el.dataset.share === "accept") {
    const picked = root.querySelector(`input[name="inv-sc-${CSS.escape(id)}"]:checked`);
    const imp = root.querySelector(`input[name="inv-imp-${CSS.escape(id)}"]:checked`);
    const couple = el.dataset.kind === "couple";
    if (couple && !window.confirm("相手のカレンダーを、2人で一緒に使います。よろしいですか？")) return "";
    await shareRpc("cal_share_accept", { p_invite: id, p_scope: picked ? picked.value : "duty", p_import: !!imp && imp.value === "yes" });
    return couple
      ? "共有しました。カレンダーが、2人で使うカレンダーになりました。"
      : "共有しました。カレンダーに、相手の名前のラベルで勤務が出ます(相手が見せている範囲だけ)。";
  }
  if (!window.confirm("このお誘いを断りますか？")) return "";
  await shareRpc("cal_share_decline", { p_invite: id });
  return "断りました。";
}
