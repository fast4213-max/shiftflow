// 祝日: Google の公開祝日カレンダー(日本の祝日)をサービスアカウントで読み、DB にキャッシュする。
// Google を呼ぶのは、その年が未取得のときと、今年以降の年を30日ごとに取り直すときだけ。
// holiday_years.source が 'manual'(手で取り込んだ年)は取り直さない。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { listEvents } from "./google.ts";
import { AppError } from "./http.ts";

const HOLIDAY_CALENDAR_ID = "ja.japanese.official#holiday@group.v.calendar.google.com";
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

function currentYearJst(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
}

async function fetchYear(year: number): Promise<{ date: string; name: string }[]> {
  const items = await listEvents(
    HOLIDAY_CALENDAR_ID,
    `${year}-01-01T00:00:00+09:00`,
    `${year + 1}-01-01T00:00:00+09:00`,
  );
  const map = new Map<string, string>();
  items.forEach((e) => {
    const date = e.start?.date;
    if (date && date.startsWith(`${year}-`)) map.set(date, e.summary || "");
  });
  return [...map.entries()].map(([date, name]) => ({ date, name }));
}

// 指定した年の祝日がキャッシュにあるようにする
export async function ensureHolidayYears(admin: SupabaseClient, years: number[]): Promise<void> {
  const unique = [...new Set(years)];
  const { data: cached, error } = await admin.from("holiday_years").select("year, source, fetched_at").in("year", unique);
  if (error) throw error;

  const thisYear = currentYearJst();
  for (const year of unique) {
    const row = (cached || []).find((r) => r.year === year);
    if (row) {
      if (row.source === "manual") continue;
      const stale = year >= thisYear && Date.now() - new Date(row.fetched_at).getTime() > REFRESH_MS;
      if (!stale) continue;
    }

    let holidays: { date: string; name: string }[] = [];
    try {
      holidays = await fetchYear(year);
    } catch (err) {
      console.error("holiday fetch failed", year, err);
    }
    if (holidays.length === 0) {
      if (row) continue; // 取り直しに失敗しても、前回の分を使う
      throw new AppError(
        503,
        `${year}年の祝日を取得できませんでした。時間をおいてもう一度お試しください。`,
        "holiday_unavailable",
      );
    }

    // 先に入れてから、無くなった日だけ消す(全部消してから入れると、その間に登録した人の祝日が平日扱いになる)。
    // 同じ年を同時に取りに来ても主キーの重複で失敗しないよう upsert にする
    const ins = await admin.from("holidays").upsert(holidays, { onConflict: "date" });
    if (ins.error) throw ins.error;
    const del = await admin.from("holidays").delete()
      .gte("date", `${year}-01-01`).lte("date", `${year}-12-31`)
      .not("date", "in", `(${holidays.map((h) => h.date).join(",")})`);
    if (del.error) throw del.error;
    const up = await admin.from("holiday_years").upsert({ year, source: "google", fetched_at: new Date().toISOString() });
    if (up.error) throw up.error;
  }
}

// from〜to(両端を含む)の祝日を "yyyy-MM-dd" の配列で返す
export async function loadHolidays(admin: SupabaseClient, from: string, to: string): Promise<string[]> {
  await ensureHolidayYears(admin, [Number(from.slice(0, 4)), Number(to.slice(0, 4))]);
  const { data, error } = await admin.from("holidays").select("date").gte("date", from).lte("date", to);
  if (error) throw error;
  return (data || []).map((r) => r.date);
}
