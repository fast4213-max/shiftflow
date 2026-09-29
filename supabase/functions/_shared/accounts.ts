// 社員番号+PIN のアカウントまわりの共通処理。
// 内部では Supabase Auth のユーザー(メール+パスワード)として扱う。利用者にメールは見せない。

import { AppError } from "./http.ts";

// 実在しないドメイン(RFC 2606 の .invalid)。メールは送らない
export const EMAIL_DOMAIN = "users.shiftflow.invalid";
export const ADMIN_EMAIL = "admin@admin.shiftflow.invalid";

export function emailFor(employeeNo: string): string {
  return `${employeeNo}@${EMAIL_DOMAIN}`;
}

// PIN(6桁)から Supabase Auth のパスワードを作る(パスワードの最小文字数を満たすため接頭辞を付ける)
export function passwordFor(pin: string): string {
  return `sf-${pin}`;
}

export function isEmployeeNo(v: unknown): v is string {
  return typeof v === "string" && /^\d{7}$/.test(v);
}

export function isPin(v: unknown): v is string {
  return typeof v === "string" && /^\d{6}$/.test(v);
}

// 全角の数字が入っても受け付ける(スマホの日本語キーボード対策)
export function toHalfWidth(v: unknown): string {
  return String(v ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
}

export function validateEmployeeNo(v: unknown): string {
  const no = toHalfWidth(v);
  if (!isEmployeeNo(no)) throw new AppError(400, "社員番号は7桁の数字で入力してください。", "bad_employee_no");
  return no;
}

export function validatePin(v: unknown, label = "PIN"): string {
  const pin = toHalfWidth(v);
  if (!isPin(pin)) throw new AppError(400, `${label}は6桁の数字で入力してください。`, "bad_pin");
  return pin;
}

export function validateName(v: unknown, label: string): string {
  const name = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new AppError(400, `${label}を入力してください。`, "bad_name");
  if (name.length > 30) throw new AppError(400, `${label}は30文字以内にしてください。`, "bad_name");
  return name;
}

// 仮のPIN(管理者が再設定するとき)
export function randomPin(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 長さや内容が漏れない比較(SHA-256 にしてから比べる)
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}
