// 祝日のキャッシュを用意する(画面の平/休表示用)。何度呼んでも同じ結果になる。
// 本文: { years: [2026, 2027] }  → { holidays: ["2026-01-01", ...] }

import { requireMember } from "../_shared/auth.ts";
import { ensureHolidayYears } from "../_shared/holidays.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  const body = await readBody(req);
  const years = (Array.isArray(body.years) ? body.years : [body.year]).map(Number);
  if (years.length === 0 || years.length > 3 || years.some((y) => !Number.isInteger(y) || y < 2000 || y > 2100)) {
    throw new AppError(400, "年の指定が正しくありません。");
  }
  await ensureHolidayYears(ctx.admin, years);
  const min = Math.min(...years);
  const max = Math.max(...years);
  const { data, error } = await ctx.admin.from("holidays").select("date")
    .gte("date", `${min}-01-01`).lte("date", `${max}-12-31`).order("date");
  if (error) throw error;
  return { holidays: (data || []).map((r) => r.date) };
});
