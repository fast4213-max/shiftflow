// レスポンスと CORS(GitHub Pages など別オリジンの画面から呼ぶため)

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 画面に表示してよいメッセージを持つエラー
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

// 関数の本体を包む: OPTIONS への応答、エラーの JSON 化
export function serve(handler: (req: Request) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "POST で呼んでください。" }, 405);
    try {
      return json(await handler(req));
    } catch (err) {
      if (err instanceof AppError) return json({ error: err.message, code: err.code }, err.status);
      console.error(err);
      return json({ error: "サーバーでエラーが発生しました。時間をおいてもう一度お試しください。" }, 500);
    }
  });
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export function yearMonthOf(body: Record<string, unknown>): { year: number; month: number } {
  const year = Number(body.year);
  const month = Number(body.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new AppError(400, "年月の指定が正しくありません。");
  }
  return { year, month };
}
