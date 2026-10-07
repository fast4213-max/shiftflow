// Discord の Webhook への通知と削除。URL は秘密なので、ログやエラーに出さない。

import type { DiscordPayload } from "./contact.ts";

export type DiscordFile = { name: string; type: string; bytes: Uint8Array };
export type DiscordResult = { ok: true; id: string } | { ok: false; status: number; error: string };

export interface Discord {
  configured: boolean;
  post(payload: DiscordPayload, files?: DiscordFile[]): Promise<DiscordResult>;
  remove(messageId: string): Promise<{ ok: boolean; status: number }>;
}

// 正しい Webhook の URL だけを使う(打ち間違いで別の所へ送らないように)
export function validWebhookUrl(url: string | undefined): string | null {
  const s = (url ?? "").trim();
  return /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(s)
    ? s
    : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function discordFromEnv(fetchFn: typeof fetch = fetch): Discord {
  const url = validWebhookUrl(Deno.env.get("DISCORD_WEBHOOK_URL"));
  if (!url) {
    return {
      configured: false,
      post: () => Promise.resolve({ ok: false, status: 0, error: "Discord の Webhook が設定されていません" }),
      remove: () => Promise.resolve({ ok: false, status: 0 }),
    };
  }

  // retryOnError: 通信エラー・時間切れのとき、もう1回送るか。通知(POST)は送らない(実は届いていて、同じ通知が2つ出るため。S8)
  async function send(init: () => RequestInit, path = "?wait=true", { retryOnError = false, timeoutMs = 10_000 } = {}): Promise<Response | Error> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchFn(url + path, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 429 && attempt === 0) {
          // 回数の制限: 待つ時間が短ければ1回だけ待ってやり直す
          const body = await res.json().catch(() => ({}));
          const wait = Number((body as { retry_after?: number }).retry_after ?? 1);
          if (wait <= 5) {
            await sleep(Math.max(0.2, wait) * 1000);
            continue;
          }
          return res;
        }
        return res;
      } catch (err) {
        if (attempt === 1 || !retryOnError) return err instanceof Error ? err : new Error(String(err));
      }
    }
    return new Error("Discord に送れませんでした");
  }

  return {
    configured: true,
    async post(payload, files = []) {
      const init = (): RequestInit => {
        if (!files.length) {
          return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
        }
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name));
        return { method: "POST", body: form };
      };
      // 画像つきは大きいので、待つ時間を長めにする(時間切れで「届いたか分からない」を減らす)
      const res = await send(init, "?wait=true", { timeoutMs: files.length ? 30_000 : 10_000 });
      // 通信エラーの文には URL(秘密)が入るので伏せる(D6)
      if (res instanceof Error) return { ok: false, status: 0, error: res.message.replaceAll(url!, "[webhook]").slice(0, 200) };
      const text = await res.text().catch(() => "");
      if (!res.ok) return { ok: false, status: res.status, error: `Discord ${res.status}: ${text.slice(0, 200)}` };
      try {
        const id = String(JSON.parse(text).id ?? "");
        return id ? { ok: true, id } : { ok: false, status: res.status, error: "Discord の応答にIDがありません" };
      } catch {
        return { ok: false, status: res.status, error: "Discord の応答を読めません" };
      }
    },
    async remove(messageId) {
      if (!/^\d{5,25}$/.test(messageId)) return { ok: false, status: 400 };
      const res = await send(() => ({ method: "DELETE" }), `/messages/${messageId}`, { retryOnError: true });
      if (res instanceof Error) return { ok: false, status: 0 };
      await res.body?.cancel().catch(() => {});
      return { ok: res.ok, status: res.status };
    },
  };
}
