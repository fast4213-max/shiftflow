// ホーム画面のアイコンを選ぶ(カレンダーの設定の一番下)。
// スマホは、「ホーム画面に追加」を押した時点のアイコンを保存する(あとから入れ替えられない)。
// だから、選んだアイコンを、ページが指す「アイコンの指定」(apple-touch-icon・設定ファイル manifest)に反映しておき、
// そのあとで「ホーム画面に追加」してもらう。すでに追加してある人は、いったん消して追加し直す。
//   iPhone: apple-touch-icon の画像がそのまま使われる
//   Android(Chrome): その時点の manifest の icons が使われる(Android で確認済み 2026-11-04)。manifest は選んだアイコン入りのものをその場で作って差し替える
// 選べるアイコン: はじめから入っているもの(今の電車だけ。コードの中の icons/)と、管理画面で足したもの(DB の app_icons・Storage の app-icons)。
// 選んだものは、この端末に覚える。URL ごと覚えるので、開いた直後(通信の前)に反映できる。

const KEY = "shiftflow.cal.icon";
const BUCKET = "app-icons";

const builtin = (id, name, f) => ({ id, name, small: f.small, touch: f.touch, any192: f.any192, any512: f.any512, maskable: f.maskable });
// はじめから入っているのは、今のアイコン(電車)だけ(manifest.webmanifest・index.html に書いてあるもの)。ほかは管理画面で足す
export const BUILTIN = [
  builtin("default", "いまの(電車)", { small: "icons/icon-192.png", touch: "icons/apple-touch-icon.png", any192: "icons/icon-192.png", any512: "icons/icon-512.png", maskable: "icons/icon-maskable-512.png" }),
];
let remote = []; // 管理画面で足したもの(読めたら入る)

const abs = (p) => new URL(p, document.baseURI).href;
function read() { try { return window.localStorage.getItem(KEY); } catch (_) { return null; } }
function write(v2) { try { if (v2 === null) window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, v2); } catch (_) { /* 覚えられない端末では、開き直すと今のアイコンに戻る */ } }

// 覚えてあるアイコン。前の版は id だけを覚えていた("green" など)ので、それも読む
function saved() {
  const raw = read();
  if (!raw) return null;
  const ok = (o) => o && (o.id === "default" || /^r\d+$/.test(o.id)); // 試作のときの「青・緑・オレンジ」を覚えていても、今のアイコンのまま(画像はもう無い)
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && o.touch && o.small) return ok(o) ? o : null;
  } catch (_) { /* id だけの古い形 */ }
  return BUILTIN.find((x) => x.id === raw) || null;
}
export const all = () => [...BUILTIN, ...remote];
export const currentId = () => (saved() || BUILTIN[0]).id;

let blobUrl = "";
function link(rel) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) { el = document.createElement("link"); el.rel = rel; document.head.appendChild(el); }
  return el;
}

// アイコンを、ページのアイコンの指定に反映する
export function apply(ic) {
  link("apple-touch-icon").href = abs(ic.touch);
  link("icon").href = abs(ic.small);
  // 設定ファイル: 写しを作って、アイコンの場所だけ差し替える。blob の中では、相対の場所は使えないので、全部 URL で書く
  const manifest = {
    id: abs("./"), name: "shiftflowカレンダー", short_name: "カレンダー", description: "勤務と予定を見るカレンダー",
    start_url: abs("./index.html"), scope: abs("./"), display: "standalone", background_color: "#fafafa", theme_color: "#fafafa", lang: "ja",
    icons: [
      { src: abs(ic.any192), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: abs(ic.any512), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: abs(ic.maskable), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  const old = blobUrl;
  try {
    blobUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }));
    link("manifest").href = blobUrl;
    if (old) URL.revokeObjectURL(old);
  } catch (_) { /* 作れなければ、もとの manifest のまま(今のアイコン) */ }
}

// 開いたときに、前に選んだアイコンを反映する(選んでいなければ、何もしない)
export function applySaved() { const ic = saved(); if (ic) apply(ic); }

export function choose(id) {
  const ic = all().find((x) => x.id === id) || BUILTIN[0];
  write(JSON.stringify(ic));
  apply(ic);
}

// 画像が読めるか。読み込みに失敗したら false。8秒たっても分からないときは true(遅いだけで外さない)
function imageExists(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(true), 8000);
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

// 管理画面で足したアイコンを読む(読めなくても、はじめから入っているものは使える)。
// 覚えてあるのが、管理画面で消された(隠された)アイコンなら、今のアイコンに戻す(消えた画像を指さないように)
export async function loadRemote(supabase, esc, onLoaded) {
  try {
    const { data, error } = await supabase.from("app_icons").select("id, name").order("sort_order").order("id");
    if (error || !Array.isArray(data)) return;
    const pub = (path) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    remote = data.map((r) => builtin("r" + r.id, r.name, {
      small: pub(`${r.id}/192.png`), touch: pub(`${r.id}/180.png`), any192: pub(`${r.id}/192.png`), any512: pub(`${r.id}/512.png`), maskable: pub(`${r.id}/512.png`),
    }));
    // 覚えてあるのが管理画面で消された(隠された)アイコンなら、今のアイコンに戻す。画像が読めないだけ(通信の不調)では戻さない
    const s = saved();
    if (s && /^r\d+$/.test(s.id) && !remote.some((x) => x.id === s.id)) { write(null); apply(BUILTIN[0]); }
    // 画像が入っていないアイコン(管理画面の追加が途中で止まって行だけ残ったもの)は、選ぶ一覧に出さない。
    // 画像が無い(404 など読み込みの失敗)と分かったものだけ外す。時間がかかるだけのものは外さない
    const alive = await Promise.all(remote.map((x) => imageExists(x.small)));
    remote = remote.filter((x, i) => alive[i]);
    // 設定が開いていたら、一覧だけ差し替える
    const card = document.getElementById("icon-pick");
    if (card) card.outerHTML = sectionHtml(esc);
    if (onLoaded) onLoaded();
  } catch (_) { /* 読めなければ、はじめから入っているものだけ */ }
}

export function sectionHtml(esc) {
  const cur = currentId();
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  const tiles = all().map((x) => `<label class="ic"><input type="radio" name="appicon" value="${esc(x.id)}"${cur === x.id ? " checked" : ""}><img src="${esc(x.small)}" alt="" width="56" height="56"><span>${esc(x.name)}</span></label>`).join("");
  return `<div class="card" id="icon-pick"><h3>ホーム画面のアイコン</h3>
    <div class="icgrid" role="radiogroup" aria-label="ホーム画面のアイコン">${tiles}</div>
    <p class="sub" id="icon-note">${standalone ? "いま、ホーム画面から開いています。" : ""}アイコンを選んだあとで、ホーム画面に追加してください(iPhone: 共有 →「ホーム画面に追加」/ Android: メニュー →「ホーム画面に追加」または「アプリをインストール」)。</p>
    <p class="sub"><b>すでにホーム画面にある人</b>は、アイコンが自動では変わりません。ホーム画面から今のアイコンを消して(Android はアンインストール)、選び直して追加し直してください。この選びは、この端末だけの設定です。</p></div>`;
}
