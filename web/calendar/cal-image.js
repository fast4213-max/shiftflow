// 設定の「月のカレンダーを画像にする」「選んだ日に〇をつけて画像にする」(家族カレンダーの同じ機能を、shiftflowカレンダーに合わせたもの)。
// 横1080pxのPNGを、端末の中(canvas)で作る。サーバーには何も送らない。
//   月の画像: いま表示しているラベル(上のボタン)の予定とスタンプが入る
//   〇の画像: 選んだ日に赤い〇だけ(予定・スタンプは入れない)
import { addDays, diffDays, layoutWeek, monthLimits, textOn, WEEKDAYS } from "./cal-core.js?v=dev";

const INK = "#1f1f22", SUB = "#7a7a80", LINE = "#e2e2e6", RED = "#d64545", BLUE = "#2f6fd6", OUT = "#f3f3f5", MARK = "#e53935";

const loadImg = (src) => new Promise((res) => {
  if (!src) return res(null);
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = () => res(null);
  im.src = src;
});
// 長い字は「…」で切る
function fitText(g, s, max) {
  s = String(s);
  if (g.measureText(s).width <= max) return s;
  while (s.length > 1 && g.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}
// 角ごとに丸みを変えられる四角(左上・右上・右下・左下)
function rrect(g, x, y, w, h, r) {
  const [tl, tr, br, bl] = r;
  g.beginPath();
  g.moveTo(x + tl, y); g.lineTo(x + w - tr, y); g.quadraticCurveTo(x + w, y, x + w, y + tr);
  g.lineTo(x + w, y + h - br); g.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  g.lineTo(x + bl, y + h); g.quadraticCurveTo(x, y + h, x, y + h - bl);
  g.lineTo(x, y + tl); g.quadraticCurveTo(x, y, x + tl, y);
  g.closePath();
}
const pad2 = (n) => String(n).padStart(2, "0");
const dateOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
// その月の画面と同じ範囲(日曜はじまりの週)
function monthWeeks(y, m) {
  const first = dateOf(y, m, 1);
  const last = dateOf(y, m, new Date(y, m, 0).getDate());
  const wd = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))).getDay();
  const start = addDays(first, -wd(first));
  const end = addDays(last, 6 - wd(last));
  return { start, end, n: Math.round((diffDays(start, end) + 1) / 7) };
}

export function createImager(env) {
  const { S, $, esc, eventsBetween, colorOf, barText, urlFor, ensureMonth, openSettings, setNotice } = env;
  const st = { marks: new Set(), mode: false, mimg: null, mkimg: null, month: "", busy: false };

  const fontOf = () => getComputedStyle(document.body).fontFamily || "sans-serif";
  const header = (g, F, y, m, W, P, TOP, CW) => {
    g.textBaseline = "alphabetic"; g.textAlign = "left"; g.fillStyle = INK;
    g.font = F(700, 34); g.fillText(String(y), P, 58);
    g.font = F(800, 88); g.fillText(String(m), P, TOP - 22);
    const mw = g.measureText(String(m)).width;
    g.font = F(800, 40); g.fillText("月", P + mw + 8, TOP - 22);
    g.font = F(700, 24); g.textAlign = "center";
    for (let i = 0; i < 7; i++) { g.fillStyle = i === 0 ? RED : i === 6 ? BLUE : SUB; g.fillText(WEEKDAYS[i], P + CW * i + CW / 2, TOP + 34); }
    g.textAlign = "left";
  };
  const grid = (g, P, GY, GW, W, CW, RH, nW) => {
    g.strokeStyle = LINE; g.lineWidth = 2;
    for (let w = 0; w <= nW; w++) { g.beginPath(); g.moveTo(P, GY + w * RH); g.lineTo(W - P, GY + w * RH); g.stroke(); }
    g.lineWidth = 1;
    for (let c = 1; c < 7; c++) { g.beginPath(); g.moveTo(P + CW * c, GY); g.lineTo(P + CW * c, GY + RH * nW); g.stroke(); }
  };
  const toBlob = (cv) => new Promise((res) => cv.toBlob(res, "image/png"));

  // ---- 月のカレンダーを画像にする(表示中のラベルの予定とスタンプ) ----
  async function drawMonthImage(y, m) {
    await ensureMonth(y, m);
    const { start, end, n: nW } = monthWeeks(y, m);
    const W = 1080, P = 36, TOP = 150, WDH = 50, RH = 230, GW = W - P * 2, CW = GW / 7, GY = TOP + WDH, H = GY + RH * nW + P;
    const F = (w, s) => `${w} ${s}px ${fontOf()}`;
    const evs = eventsBetween(start, end);
    const defOf = (id) => S.stampDefs.find((d) => d.id === id);
    const sts = S.stamps.filter((s) => s.date >= start && s.date <= end && defOf(s.stamp_def_id));
    const imgs = {};
    for (const s of sts) {
      const d = defOf(s.stamp_def_id);
      if (d.kind === "image" && !(d.image_path in imgs)) {
        const u = await imageUrl(d.image_path);
        imgs[d.image_path] = await loadImg(u);
        if (u) URL.revokeObjectURL(u); // 読み込んだあとは要らない(メモリを残さない)
      }
    }
    try { await document.fonts.ready; } catch (_) { /* 待てなくても描ける */ }
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
    header(g, F, y, m, W, P, TOP, CW);
    const MAXL = 4, BH = 34, BG = 6, BT = 50;
    for (let w = 0; w < nW; w++) {
      const ws = addDays(start, w * 7), top = GY + w * RH;
      for (let c = 0; c < 7; c++) {
        const di = addDays(ws, c), x = P + CW * c, inM = Number(di.slice(5, 7)) === m, hol = S.holidays.get(di);
        if (!inM) { g.fillStyle = OUT; g.fillRect(x, top, CW, RH); }
        g.globalAlpha = inM ? 1 : 0.45;
        g.font = F(700, 30); g.fillStyle = (c === 0 || hol) ? RED : c === 6 ? BLUE : INK;
        const dn = String(Number(di.slice(8, 10)));
        g.fillText(dn, x + 10, top + 36);
        if (hol) { const dw = g.measureText(dn).width; g.font = F(700, 17); g.fillStyle = RED; g.fillText(fitText(g, hol, CW - dw - 26), x + dw + 18, top + 34); }
        g.globalAlpha = 1;
      }
      const { bars, over } = layoutWeek(ws, evs, MAXL);
      for (const b of bars) {
        const col = colorOf(b.event.labelId);
        const x1 = P + CW * b.c1 + (b.cutLeft ? 0 : 3), x2 = P + CW * (b.c2 + 1) - (b.cutRight ? 0 : 3), by = top + BT + b.lane * (BH + BG);
        g.fillStyle = col; rrect(g, x1, by, x2 - x1, BH, [b.cutLeft ? 0 : 6, b.cutRight ? 0 : 6, b.cutRight ? 0 : 6, b.cutLeft ? 0 : 6]); g.fill();
        g.fillStyle = textOn(col); g.font = F(700, 20);
        g.textBaseline = "middle";
        g.fillText(fitText(g, barText(b.event), x2 - x1 - 14), x1 + 7, by + BH / 2 + 1);
        g.textBaseline = "alphabetic";
      }
      for (let c = 0; c < 7; c++) if (over[c]) { g.font = F(700, 18); g.fillStyle = SUB; g.textAlign = "right"; g.fillText(`+${over[c]}`, P + CW * (c + 1) - 8, top + RH - 10); g.textAlign = "left"; }
    }
    grid(g, P, GY, GW, W, CW, RH, nW);
    // スタンプ(カレンダーの中だけ・いちばん前)
    g.save(); g.beginPath(); g.rect(P, GY, GW, RH * nW); g.clip();
    for (const s of sts) {
      const d = defOf(s.stamp_def_id), k = diffDays(start, s.date), wi = Math.floor(k / 7), c = k % 7;
      const cy = GY + RH * (wi + s.y), sw = s.size * CW;
      let cx = P + CW * (c + s.x);
      // 横に長い文字のスタンプは、カレンダーの左右の端で切れないように、内側にずらして描く(画面と同じ。保存してある位置は変えない。AN2)
      if (d.kind === "text") {
        const fs = sw * 0.34; g.font = F(700, fs);
        const bw = g.measureText(d.text).width + fs * 1.1, bh = fs * 1.5, a = (s.rotation || 0) * Math.PI / 180;
        const half = (Math.abs(bw * Math.cos(a)) + Math.abs(bh * Math.sin(a))) / 2;
        if (half * 2 < GW) cx = Math.min(Math.max(cx, P + half), P + GW - half);
      }
      g.save(); g.translate(cx, cy); g.rotate((s.rotation || 0) * Math.PI / 180);
      if (d.kind === "emoji") {
        g.font = F(400, sw * 0.8); g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = INK; g.fillText(d.emoji, 0, sw * 0.04);
      } else if (d.kind === "image") {
        const im = imgs[d.image_path];
        if (im) { const k2 = Math.min(sw / im.width, sw / im.height), iw = im.width * k2, ih = im.height * k2; g.drawImage(im, -iw / 2, -ih / 2, iw, ih); }
      } else {
        const fs = sw * 0.34; g.font = F(700, fs);
        const tw = g.measureText(d.text).width, bw = tw + fs * 1.1, bh = fs * 1.5;
        const r = d.shape === "round" ? [bh / 2, bh / 2, bh / 2, bh / 2] : d.shape === "square" ? [fs * 0.25, fs * 0.25, fs * 0.25, fs * 0.25] : [fs * 0.8, fs * 0.8, fs * 0.8, 0];
        g.fillStyle = d.bg_color; rrect(g, -bw / 2, -bh / 2, bw, bh, r); g.fill();
        g.fillStyle = d.text_color; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(d.text, 0, fs * 0.05);
      }
      g.restore();
    }
    g.restore();
    return toBlob(cv);
  }
  // 画像のスタンプは、別のサイトの URL なので、いったん取り込んでから描く(そのまま描くと、画像として保存できなくなる)
  async function imageUrl(path) {
    try {
      const u = await urlFor(path);
      if (!u) return "";
      const r = await fetch(u);
      if (!r.ok) return "";
      return URL.createObjectURL(await r.blob());
    } catch (_) { return ""; }
  }

  // ---- 選んだ日に〇をつけた月の画像(予定・スタンプは入れない) ----
  async function drawMarkImage(y, m) {
    const { start, n: nW } = monthWeeks(y, m);
    const W = 1080, P = 36, TOP = 150, WDH = 50, RH = 150, GW = W - P * 2, CW = GW / 7, GY = TOP + WDH, H = GY + RH * nW + P;
    const F = (w, s) => `${w} ${s}px ${fontOf()}`;
    try { await document.fonts.ready; } catch (_) { /* 待てなくても描ける */ }
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
    header(g, F, y, m, W, P, TOP, CW);
    for (let w = 0; w < nW; w++) {
      const top = GY + w * RH;
      for (let c = 0; c < 7; c++) {
        const di = addDays(start, w * 7 + c), x = P + CW * c, cx = x + CW / 2, cy = top + RH / 2, inM = Number(di.slice(5, 7)) === m, hol = S.holidays.get(di);
        if (!inM) { g.fillStyle = OUT; g.fillRect(x, top, CW, RH); }
        g.globalAlpha = inM ? 1 : 0.4;
        g.textAlign = "center"; g.font = F(700, 40); g.fillStyle = (c === 0 || hol) ? RED : c === 6 ? BLUE : INK;
        g.fillText(String(Number(di.slice(8, 10))), cx, cy + 14);
        if (hol && inM) { g.font = F(700, 16); g.fillStyle = RED; g.fillText(fitText(g, hol, CW - 12), cx, top + RH - 10); }
        g.globalAlpha = 1;
        if (inM && st.marks.has(di)) { g.strokeStyle = MARK; g.lineWidth = 7; g.beginPath(); g.arc(cx, cy, Math.min(CW, RH) * 0.36, 0, Math.PI * 2); g.stroke(); }
      }
    }
    g.textAlign = "left";
    grid(g, P, GY, GW, W, CW, RH, nW);
    return toBlob(cv);
  }

  // ---- 設定の画面 ----
  const lim = () => monthLimits(S.today);
  const monthValue = () => st.month || `${S.y}-${pad2(S.m)}`;
  function sectionsHtml() {
    const l = lim(), min = `${l.min.y}-${pad2(l.min.m)}`, max = `${l.max.y}-${pad2(l.max.m)}`;
    const n = st.marks.size;
    const shown = (r, alt) => `<img class="mimg" src="${esc(r.url)}" alt="${esc(r.label)}の${alt}">`;
    return `<div class="card" id="mimg"><h3>月のカレンダーを画像にする</h3>
      <div class="row2"><input class="in" type="month" id="mi-month" value="${esc(monthValue())}" min="${min}" max="${max}" aria-label="月"><button class="btn pri" data-act="img-make"${st.busy ? " disabled" : ""}>画像を作る</button></div>
      ${st.mimg ? `${shown(st.mimg, "カレンダーの画像")}<div class="row2"><button class="btn pri" data-act="img-share">共有する</button><button class="btn" data-act="img-save">保存する</button></div>` : ""}
      <p class="sub">いま表示しているラベル(上のボタン)の予定とスタンプが入ります。隠したラベルの予定は入りません。LINEで送ったり、印刷したりできます。</p>
      <details class="more"><summary>詳しい説明</summary><p class="sub">月を選んで「画像を作る」を押すと、その月を1枚の画像(横1080px)にします。選べるのは、過去1年から来年の12月までです。「共有する」でLINEなどに送れます。共有できない端末では、画像を保存します。画像は端末の中で作り、サーバーには送りません。予定が多い日は、見やすいように4つまでを並べて、残りは「+数」で出します。画像のスタンプが読み込めなかったときは、その分だけ入りません。</p></details>
      <p class="msg err" id="img-msg"></p></div>
    <div class="card" id="mkimg"><h3>選んだ日に〇をつけて画像にする</h3>
      <div class="row2"><button class="btn pri" data-act="mark-start">${n ? `日を選び直す(${n}日)` : "日を選ぶ"}</button>${n ? '<button class="btn" data-act="mark-clear">選んだ日を全部外す</button>' : ""}</div>
      ${(st.mkimg || []).map((r) => shown(r, "、〇をつけたカレンダーの画像")).join("")}
      ${st.mkimg && st.mkimg.length ? '<div class="row2"><button class="btn pri" data-act="mark-share">共有する</button><button class="btn" data-act="mark-save">保存する</button></div>' : ""}
      <p class="sub">カレンダーで予定を見ながら日をタップすると、赤い〇がつきます(もう一度タップで外す)。画像には予定やスタンプは入らず、選んだ日の〇だけが入ります。月をまたぐと、月ごとに1枚ずつ作ります。</p>
      <details class="more"><summary>詳しい説明</summary><p class="sub">「日を選ぶ」を押すと、設定が閉じてカレンダーが見えます。予定を見ながら日をタップすると〇がつき、下に選んだ日数が出ます。「画像を作る」を押すと、設定に戻って画像が出ます。日を選んでいる途中で、予定の追加・設定・スタンプなどのメニューを押すと、選ぶのをやめます(選んだ日は残ります)。選んだ日は「選んだ日を全部外す」か、アプリを閉じるまで残ります。授業参観・提出日・ごみの日など、印をつけて人に送りたい日に使えます。</p></details>
      <p class="msg err" id="mk-msg"></p></div>`;
  }
  const say = (id, text, ok = false) => { const el = $(id); if (el) { el.textContent = text || ""; el.className = "msg " + (ok ? "ok" : "err"); } };
  const revoke = (r) => { if (r && r.url) URL.revokeObjectURL(r.url); };

  function saveFile(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  // 共有(LINEなど)。使えない端末は、画像を保存する
  async function share(list, title, msgId) {
    if (!list.length) return;
    let files = null;
    try { files = list.map((r) => new File([r.blob], r.name, { type: "image/png" })); } catch (_) { /* File が使えない端末 */ }
    const saveAll = () => list.forEach((r, i) => setTimeout(() => saveFile(r.blob, r.name), i * 400));
    if (files && navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title }); } catch (e) { if (e && e.name !== "AbortError") { saveAll(); say(msgId, "画像を保存しました。", true); } }
    } else { saveAll(); say(msgId, "この端末では共有できないので、画像を保存しました。", true); }
  }

  // ---- 日を選ぶモード ----
  function renderBar() {
    const b = $("markbar");
    if (!b) return;
    b.hidden = !st.mode;
    if (!st.mode) { b.innerHTML = ""; return; }
    const n = st.marks.size;
    b.innerHTML = `<span class="cnt">${n ? `${n}日を選んでいます` : "〇をつける日をタップ"}</span><button class="btn" data-act="mark-close">やめる</button><button class="btn pri" data-act="mark-make"${n ? "" : " disabled"}>画像を作る</button>`;
  }
  function setMode(on) {
    st.mode = on;
    document.body.classList.toggle("mark-mode", on);
    renderBar();
    env.render();
  }
  function toggleDate(date) {
    if (st.marks.has(date)) st.marks.delete(date); else st.marks.add(date);
    renderBar();
    env.render();
  }

  async function act(name, el) {
    if (name === "img-make") {
      const v = (($("mi-month") || {}).value || "").trim(), mm = /^(\d{4})-(\d{2})$/.exec(v);
      if (!mm) return say("img-msg", "月を選んでください。");
      const y = Number(mm[1]), m = Number(mm[2]), l = lim();
      const idx = y * 12 + m, lo = l.min.y * 12 + l.min.m, hi = l.max.y * 12 + l.max.m;
      if (idx < lo || idx > hi) return say("img-msg", `${l.min.y}年${l.min.m}月から${l.max.y}年${l.max.m}月の間で選んでください。`);
      st.month = v; st.busy = true;
      el.disabled = true; say("img-msg", "画像を作っています…", true);
      try {
        const blob = await drawMonthImage(y, m);
        revoke(st.mimg);
        st.mimg = { url: URL.createObjectURL(blob), blob, name: `calendar-${v}.png`, label: `${y}年${m}月` };
        st.busy = false;
        // 作っている間に別のパネルを開いていたら、上書きしない(設定がまだ開いているときだけ入れ替える)
        if ($("mimg")) env.setPanel(env.settingsHtml());
        setTimeout(() => { const e2 = $("mimg"); if (e2) e2.scrollIntoView({ block: "start", behavior: "smooth" }); }, 30);
      } catch (e) { st.busy = false; el.disabled = false; say("img-msg", "画像を作れませんでした。"); }
    } else if (name === "img-share") {
      if (st.mimg) await share([st.mimg], `${st.mimg.label}のカレンダー`, "img-msg");
    } else if (name === "img-save") {
      if (st.mimg) { saveFile(st.mimg.blob, st.mimg.name); say("img-msg", "画像を保存しました。", true); }
    } else if (name === "mark-start") {
      env.closePanel();
      if (env.stampOff) env.stampOff();
      setMode(true);
    } else if (name === "mark-close") {
      setMode(false);
    } else if (name === "mark-clear") {
      st.marks.clear(); (st.mkimg || []).forEach(revoke); st.mkimg = null;
      if (st.mode) setMode(false);
      env.setPanel(env.settingsHtml());
      env.render();
    } else if (name === "mark-make") {
      if (!st.marks.size) return;
      const months = [...new Set([...st.marks].map((d) => d.slice(0, 7)))].sort();
      setNotice("画像を作っています…");
      try {
        const out = [];
        for (const ym of months) {
          const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
          const blob = await drawMarkImage(y, m);
          out.push({ url: URL.createObjectURL(blob), blob, name: `maru-${ym}.png`, label: `${y}年${m}月` });
        }
        (st.mkimg || []).forEach(revoke);
        st.mkimg = out;
        setNotice("");
        setMode(false);
        openSettings();
        setTimeout(() => { const e2 = $("mkimg"); if (e2) e2.scrollIntoView({ block: "start", behavior: "smooth" }); }, 60);
      } catch (e) { setNotice("画像を作れませんでした。"); }
    } else if (name === "mark-share") {
      await share(st.mkimg || [], "〇をつけたカレンダー", "mk-msg");
    } else if (name === "mark-save") {
      const rs = st.mkimg || [];
      rs.forEach((r, i) => setTimeout(() => saveFile(r.blob, r.name), i * 400));
      if (rs.length) say("mk-msg", "画像を保存しました。", true);
    }
  }

  return {
    sectionsHtml, act,
    isMarking: () => st.mode,
    isMarked: (d) => st.mode && st.marks.has(d),
    toggleDate, end: () => { if (st.mode) setMode(false); },
    renderBar,
  };
}
