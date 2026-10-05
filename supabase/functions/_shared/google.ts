// Google Calendar API をサービスアカウントで呼ぶ。
// 鍵はシークレット GOOGLE_SERVICE_ACCOUNT_JSON(鍵ファイルの JSON をそのまま)にだけ置く。

import { AppError } from "./http.ts";
import { addDays } from "./plan.js";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";
export const APP_TAG = "shiftflow";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

let cachedAccount: ServiceAccount | null = null;
let cachedToken: { token: string; expires: number } | null = null;

export function serviceAccount(): ServiceAccount {
  if (cachedAccount) return cachedAccount;
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("シークレット GOOGLE_SERVICE_ACCOUNT_JSON がありません");
  const json = JSON.parse(raw);
  if (!json.client_email || !json.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON の形式が違います");
  cachedAccount = json;
  return json;
}

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expires - 60 > now) return cachedToken.token;

  const sa = serviceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const key = await importKey(sa.private_key);
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)),
  );
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) {
    console.error("token error", res.status, await res.text());
    throw new Error("サービスアカウントの認証に失敗しました");
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expires: now + Number(data.expires_in || 3600) };
  return cachedToken.token;
}

export class GoogleError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status: number, reason: string): boolean {
  return status === 429 || status >= 500 ||
    (status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason));
}

// 再試行の待ち時間。Google カレンダー API の回数の上限(1分600回、全員の合計)は1分たつと戻るので、
// 混んでいるときは1分近く待てるようにしてある(合計で約67秒。ずらし込みで約50〜84秒)。
// 全員が同じ時刻に再試行してまた一斉に当たらないよう、待ち時間は ±25% ずらす。テストは baseMs を短くして使う
export const retryPolicy = { baseMs: [2000, 5000, 10000, 20000, 30000], jitter: 0.25 };

// 登録・削除の全体の時間の上限(withRetryBudget)に、待ち時間を収める。
// 上限が無い呼び出し(祝日の読み込み・接続テストなど)は、呼び出しごとに15秒まで
const DEFAULT_RETRY_MS = 15_000;

type Budget = { deadline: number };
let budgetStore: { getStore(): Budget | undefined; run<T>(store: Budget, fn: () => T): T } | null = null;
try {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  budgetStore = new AsyncLocalStorage<Budget>();
} catch {
  // 使えない実行環境では、上限なし(呼び出しごとに15秒)の動きになるだけ
}

// fn の中の Google の呼び出しは、いまから ms ミリ秒までに終わるように再試行する(待って次の再試行が超えるなら諦める)。
// 二重実行防止のロック(150秒)より短くしておく
export function withRetryBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return budgetStore ? budgetStore.run({ deadline: Date.now() + ms }, fn) : fn();
}

// i回目(0から)の再試行の前に待つミリ秒。再試行の回数が尽きた・待つと期限を超えるときは null
export function nextRetryDelay(i: number, now: number, deadline: number, random = Math.random()): number | null {
  const base = retryPolicy.baseMs[i];
  if (base === undefined) return null;
  const wait = Math.round(base * (1 - retryPolicy.jitter + 2 * retryPolicy.jitter * random));
  return now + wait > deadline ? null : wait;
}

// 短時間に大量に作成・削除すると失敗することがあるので、待ってから再試行する
async function call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<any> {
  const url = new URL(API + path);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const deadline = budgetStore?.getStore()?.deadline ?? Date.now() + DEFAULT_RETRY_MS;
  for (let i = 0; ; i++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.status === 204 ? null : await res.json();

    const text = await res.text();
    let reason = "";
    let message = text;
    try {
      const err = JSON.parse(text).error;
      reason = err?.errors?.[0]?.reason || err?.status || "";
      message = err?.message || text;
    } catch { /* JSON でなければそのまま */ }

    const wait = isRetryable(res.status, reason) ? nextRetryDelay(i, Date.now(), deadline) : null;
    if (wait !== null) {
      await sleep(wait);
      continue;
    }
    throw new GoogleError(res.status, reason, message);
  }
}

const cal = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;

export type CalendarEvent = {
  id: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
};

// 終日予定を作る。アプリが作った印として extendedProperties.private.shiftflow = kind を付ける
// (extendedProperties.private.shiftflow = day / offduty)
export async function insertAllDayEvent(
  calendarId: string,
  e: { date: string; endDate: string; title: string; description?: string; kind: string },
): Promise<CalendarEvent> {
  return await call("POST", `${cal(calendarId)}/events`, {
    summary: e.title,
    ...(e.description ? { description: e.description } : {}),
    start: { date: e.date },
    end: { date: e.endDate },
    extendedProperties: { private: { [APP_TAG]: e.kind } },
  });
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  try {
    await call("DELETE", `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
  } catch (err) {
    // すでに消えている予定は成功扱い
    if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

// 時間つきの予定を作る(日本時間)。startMin / endMin は、その日の0時からの分(24時間を超えたら翌日)。
// 出勤を終日2件で登録する設定のときの、2件目(出勤時間の予定)に使う
export async function insertTimedEvent(
  calendarId: string,
  e: { date: string; startMin: number; endMin: number; title: string; description?: string; kind: string },
): Promise<CalendarEvent> {
  const at = (min: number) => {
    const day = Math.floor(min / 1440);
    const rest = min % 1440;
    const pad = (n: number) => (n < 10 ? "0" : "") + n;
    return `${addDays(e.date, day)}T${pad(Math.floor(rest / 60))}:${pad(rest % 60)}:00`;
  };
  return await call("POST", `${cal(calendarId)}/events`, {
    summary: e.title,
    ...(e.description ? { description: e.description } : {}),
    start: { dateTime: at(e.startMin), timeZone: "Asia/Tokyo" },
    end: { dateTime: at(e.endMin), timeZone: "Asia/Tokyo" },
    extendedProperties: { private: { [APP_TAG]: e.kind } },
  });
}

// 期間内の予定を全部取る(ページング込み)
export async function listEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string,
  extra: Record<string, string> = {},
): Promise<CalendarEvent[]> {
  const items: CalendarEvent[] = [];
  let pageToken = "";
  do {
    const data = await call("GET", `${cal(calendarId)}/events`, undefined, {
      timeMin,
      timeMax,
      singleEvents: "true",
      maxResults: "2500",
      ...extra,
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
}

// Google のエラーを、画面に出すメッセージに変える
export function calendarAccessError(err: unknown, label: string): AppError {
  if (err instanceof GoogleError && [400, 401, 403, 404].includes(err.status)) {
    return new AppError(
      400,
      `${label}に書き込めません。共有設定(権限を「すべての予定の詳細の変更や表示ができます」にして共有しているか)とカレンダーIDを確認してください。`,
      "calendar_access",
    );
  }
  return new AppError(502, `${label}の操作に失敗しました。時間をおいてもう一度お試しください。`, "calendar_error");
}

// 同時に動かす数を絞って順に処理する。
// 失敗したら残りは始めず、動いている分が終わるのを待ってから最初のエラーを投げる
// (すぐに投げると、残りが裏で動き続けたまま二重実行防止のロックが外れ、やり直しの登録と重なるため)
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length && errors.length === 0) {
      const item = items[index++];
      try {
        await fn(item);
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length) throw errors[0];
}
