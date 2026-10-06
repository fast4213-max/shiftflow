// 専用 Gmail の GAS(ウェブアプリ)を呼んで、メールを送る。
// GAS は合言葉(MAIL_RELAY_SECRET)を確かめてから、決まった形のメールだけを送る(docs/contact/gas/Code.gs)。
// 時間切れ・通信の失敗のときは、送れたかどうか分からないので "unknown" にする(同じ key で送り直しても、GAS は2通目を送らない)。

export type RelayOk = { ok: true; message_id: string; thread_id: string; quota?: number; duplicate?: boolean };
export type RelayResult = RelayOk | { ok: false; kind: "failed" | "unknown"; error: string };

export type ReplyRequest = { key: string; to: string; subject: string; body: string; reply_to_message_id?: string | null };
export type ReceiptRequest = { key: string; subject: string; body: string; images: { name: string; type: string; data: string }[] };

export interface MailRelay {
  configured: boolean;
  reply(req: ReplyRequest): Promise<RelayResult>;
  receipt(req: ReceiptRequest): Promise<RelayResult>;
}

export function validRelayUrl(url: string | undefined): string | null {
  const s = (url ?? "").trim();
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(s) ? s : null;
}

export function relayFromEnv(fetchFn: typeof fetch = fetch): MailRelay {
  const url = validRelayUrl(Deno.env.get("MAIL_RELAY_URL"));
  const secret = Deno.env.get("MAIL_RELAY_SECRET") ?? "";
  if (!url || secret.length < 16) {
    const notSet = () =>
      Promise.resolve<RelayResult>({ ok: false, kind: "failed", error: "メールの中継(GAS)が設定されていません" });
    return { configured: false, reply: notSet, receipt: notSet };
  }

  async function call(action: string, payload: Record<string, unknown>): Promise<RelayResult> {
    let res: Response;
    try {
      res = await fetchFn(url!, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...payload, action, secret, ts: Date.now() }),
        redirect: "follow",
        signal: AbortSignal.timeout(28_000),
      });
    } catch (err) {
      // 通信エラーの文には URL が入るので伏せる
      const msg = (err instanceof Error ? err.message : String(err)).replaceAll(url!, "[GAS]");
      return { ok: false, kind: "unknown", error: `GAS から返事がありませんでした(${msg.slice(0, 100)})` };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // 5xx は GAS の中で止まった(送れたか分からない)。4xx は受け付けられていない
      return { ok: false, kind: res.status >= 500 ? "unknown" : "failed", error: `GAS ${res.status}` };
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        kind: "failed",
        error: "GAS の応答を読めません(ウェブアプリのアクセスが「全員」になっているか、デプロイを確認してください)",
      };
    }
    if (json.ok !== true) return { ok: false, kind: "failed", error: String(json.error ?? "GAS でエラー").slice(0, 300) };
    return {
      ok: true,
      message_id: String(json.message_id ?? ""),
      thread_id: String(json.thread_id ?? ""),
      quota: typeof json.quota === "number" ? json.quota : undefined,
      duplicate: json.duplicate === true,
    };
  }

  return {
    configured: true,
    reply: (req) => call("reply", req),
    receipt: (req) => call("receipt", req),
  };
}
