// ホーム画面のアイコンを選ぶ(試作)。
// スマホは、「ホーム画面に追加」を押した時点のアイコンを保存する(あとから入れ替えられない)。
// だから、選んだアイコンを、ページが指す「アイコンの指定」(apple-touch-icon・設定ファイル manifest)に反映しておき、
// そのあとで「ホーム画面に追加」してもらう。すでに追加してある人は、いったん消して追加し直す。
//   iPhone: apple-touch-icon の画像がそのまま使われる
//   Android(Chrome): その時点の manifest の icons が使われる。manifest は選んだアイコン入りのものをその場で作って差し替える
// 画像は icons/ の中(画像の置き場所は、あとで管理画面から追加できる形に変える予定)。

const KEY = "shiftflow.cal.icon";
// 先頭は今のアイコン(manifest.webmanifest・index.html に書いてあるもの)。ほかは icons/v/<id>-<大きさ>.png
export const ICONS = [
  { id: "default", name: "いまの(電車)", small: "icons/icon-192.png", touch: "icons/apple-touch-icon.png", any192: "icons/icon-192.png", any512: "icons/icon-512.png", maskable: "icons/icon-maskable-512.png" },
  { id: "blue", name: "青" }, { id: "green", name: "緑" }, { id: "orange", name: "オレンジ" },
].map((x) => x.id === "default" ? x : { ...x, small: `icons/v/${x.id}-192.png`, touch: `icons/v/${x.id}-180.png`, any192: `icons/v/${x.id}-192.png`, any512: `icons/v/${x.id}-512.png`, maskable: `icons/v/${x.id}-512.png` });

function get() { try { return window.localStorage.getItem(KEY); } catch (_) { return null; } }
function set(v) { try { window.localStorage.setItem(KEY, v); } catch (_) { /* 覚えられない端末では、開き直すと今のアイコンに戻る */ } }
const abs = (p) => new URL(p, document.baseURI).href;
export const iconOf = (id) => ICONS.find((x) => x.id === id) || ICONS[0];
export const currentId = () => iconOf(get()).id;

let blobUrl = "";
function link(rel) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) { el = document.createElement("link"); el.rel = rel; document.head.appendChild(el); }
  return el;
}

// 選んだアイコンを、ページのアイコンの指定に反映する
export function apply(id) {
  const ic = iconOf(id);
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
export function applySaved() { if (get()) apply(currentId()); }

export function choose(id) {
  set(iconOf(id).id);
  apply(id);
}

export function sectionHtml(esc) {
  const cur = currentId();
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  const tiles = ICONS.map((x) => `<label class="ic"><input type="radio" name="appicon" value="${esc(x.id)}"${cur === x.id ? " checked" : ""}><img src="${esc(x.small)}" alt="" width="56" height="56"><span>${esc(x.name)}</span></label>`).join("");
  return `<div class="card" id="icon-pick"><h3>ホーム画面のアイコン</h3>
    <div class="icgrid" role="radiogroup" aria-label="ホーム画面のアイコン">${tiles}</div>
    <p class="sub" id="icon-note">${standalone ? "いま、ホーム画面から開いています。" : ""}アイコンを選んだあとで、ホーム画面に追加してください(iPhone: 共有 →「ホーム画面に追加」/ Android: メニュー →「ホーム画面に追加」または「アプリをインストール」)。</p>
    <p class="sub"><b>すでにホーム画面にある人</b>は、アイコンが自動では変わりません。ホーム画面から今のアイコンを消して(Android はアンインストール)、選び直して追加し直してください。この選びは、この端末だけの設定です。</p></div>`;
}
