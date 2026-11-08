// アナウンスの行(ラベルのボタンの列と曜日の列の間)。設計は docs/mycalendar/DESIGN.md の「アナウンス」。
// 1件ずつ、4秒ごとに下から上へ入れ替える(電光掲示板のように)。1行に入らない長い文字は、その1件だけ横に流してから次へ。
// 右の端の「1/3」を押すと一覧(onList)、文字を押すとその1件(onOpen)。端末で「動きを減らす」にしている人には、動きを付けない。
// 出すもの(並べ方・10件まで)は cal-core.js の announceItems / ANNOUNCE_MAX で決める。
import { ANNOUNCE_MAX } from "./cal-core.js?v=dev";

const STEP_MS = 4000;  // 1件を出しておく時間
const MARQUEE_PX_PER_S = 45; // 長い文字を横に流す速さ
const MARQUEE_WAIT_MS = 1200; // 流し始める前と、流し終わったあとに止めておく時間

export function createAnnouncer({ el, esc, onOpen, onList }) {
  let all = [], items = [], idx = 0, key = "", timer = 0;
  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };

  function show(animate) {
    clearTimeout(timer);
    const it = items[idx];
    if (!it) return;
    el.innerHTML = `<button type="button" class="ann-t" data-ann="open" aria-label="アナウンス: ${esc(it.text)}"><span class="ann-w"><span class="ann-i${animate && !reduced() ? " in" : ""}"><span class="ann-m">${esc(it.text)}</span></span></span></button>`
      + `<button type="button" class="ann-n" data-ann="list" aria-label="アナウンスの一覧(${items.length}件中${idx + 1}件目)">${idx + 1}/${items.length}</button>`;
    let stay = STEP_MS;
    const w = el.querySelector(".ann-w"), m = el.querySelector(".ann-m");
    const over = m && w ? m.scrollWidth - w.clientWidth : 0;
    if (over > 2 && !reduced()) {
      const move = Math.round((over / MARQUEE_PX_PER_S) * 1000);
      m.style.setProperty("--ov", `${-over}px`);
      m.style.animation = `annmq ${move}ms linear ${MARQUEE_WAIT_MS}ms forwards`;
      stay = Math.max(STEP_MS, MARQUEE_WAIT_MS + move + MARQUEE_WAIT_MS);
    }
    // 1件だけで、横に流す必要もないときは、切り替えない
    if (items.length > 1 || (over > 2 && !reduced())) timer = setTimeout(() => { idx = (idx + 1) % items.length; show(items.length > 1); }, stay);
  }

  // 出すものを入れ直す。中身が同じなら、今の切り替えをそのまま続ける(描き直しのたびに1件目に戻らないように)
  function set(list) {
    all = list || [];
    const top = all.slice(0, ANNOUNCE_MAX);
    const k = top.map((x) => x.key + "|" + x.text).join("\n") + "#" + all.length;
    if (k === key) return;
    const was = items[idx] && items[idx].key;
    key = k;
    items = top;
    const keep = items.findIndex((x) => x.key === was);
    idx = keep >= 0 ? keep : 0;
    el.hidden = !items.length;
    clearTimeout(timer);
    if (items.length) show(false); else el.innerHTML = "";
  }

  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ann]");
    if (!b) return;
    if (b.dataset.ann === "list") onList(all);
    else if (items[idx]) onOpen(items[idx]);
  });

  return { set, all: () => all };
}
