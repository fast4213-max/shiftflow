// 写真取込(勤務表の写真を Claude のアーティファクトで読み取った内容)の受け取り。
// アーティファクトは、勤務入力画面へのリンク(input.html#import=…)か、コピーした文字(shiftflow-import:…)で渡してくる。
// 中身は { v: 1, y: 年, m: 月, d: { "1": ["番号", "メモ"], … } } の JSON を UTF-8 にして base64url にしたもの。
// 送られてきた文字はだれでも作れるので、形・長さを厳しく確かめる。設計は docs/photo/DESIGN.md
import { daysInMonth } from "./plan.js?v=dev";

const STASH_KEY = "sf_import";
const STASH_MAX_AGE_MS = 60 * 60 * 1000; // ログインし直す間だけ覚えておく
const MAX_TEXT = 20000;

// 取込の文字を読む。リンク全体・「shiftflow-import:…」・「import=…」・中身だけ、のどれでもよい。
// 読めなければ、利用者に見せる理由を Error で投げる
export function decodeImport(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("貼り付けた文字が空です。写真取込の「コピー」を押してから貼り付けてください。");
  if (raw.length > MAX_TEXT) throw new Error("取込の文字が長すぎます。写真取込の「コピー」で写した文字だけを貼り付けてください。");
  const m = raw.match(/(?:shiftflow-import:|import=)\s*([A-Za-z0-9_-]+)/) || raw.match(/^([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("取込の文字ではありません。写真取込の「コピー」で写した文字を、そのまま貼り付けてください。");

  let data;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("取込の文字が途中で切れているか、壊れています。写真取込の「コピー」からやり直してください。");
  }

  const bad = () => new Error("取込の中身の形が違います。写真取込を最新にして、やり直してください。");
  if (!data || typeof data !== "object" || data.v !== 1) throw bad();
  const year = data.y;
  const month = data.m;
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw bad();
  if (!data.d || typeof data.d !== "object" || Array.isArray(data.d)) throw bad();

  const n = daysInMonth(year, month);
  const days = new Map();
  for (const [k, v] of Object.entries(data.d)) {
    const d = Number(k);
    if (!Number.isInteger(d) || d < 1 || d > n || String(d) !== k) throw bad();
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") throw bad();
    const code = clean(v[0]).slice(0, 30);
    const memo = clean(v[1]).slice(0, 200);
    if (code || memo) days.set(d, { code, memo });
  }
  return { year, month, days };
}

// 改行・制御文字を空白にして、前後の空白を取る
function clean(s) {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

// 開いたときのアドレスの「#import=…」を覚えておき、アドレスからは消す
// (読み直しで二重に入らないように。ログインが切れてログイン画面へ移っても、戻ったときに使えるように)
export function captureImportFromHash() {
  const hash = location.hash || "";
  if (!hash.startsWith("#import=")) return;
  stashImport(hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
}

// 取込の文字を覚えておく(画面の読み込みに失敗したときも、読み直したときに使えるように。K5)
export function stashImport(text) {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ text, at: Date.now() }));
  } catch {
    // 覚えておけない(プライベートブラウズなど)。このページの中でだけ使う
    pendingInPage = text;
  }
}

let pendingInPage = "";

// 覚えておいた取込の文字を1回だけ取り出す(古いものは捨てる)
export function takePendingImport() {
  if (pendingInPage) {
    const text = pendingInPage;
    pendingInPage = "";
    return text;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STASH_KEY) || "null");
    sessionStorage.removeItem(STASH_KEY);
    if (saved && typeof saved.text === "string" && Date.now() - saved.at < STASH_MAX_AGE_MS) return saved.text;
  } catch {
    // 読めなければ、取込は無かったことにする
  }
  return "";
}
