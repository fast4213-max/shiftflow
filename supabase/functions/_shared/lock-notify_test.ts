// PIN の長いロックの知らせ(AD1)のテスト
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import type { Discord } from "./discord.ts";
import { pinLockNotifier, pinLockPayload } from "./lock-notify.ts";

function fakeAdmin() {
  const rows: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      assertEquals(table, "discord_posts");
      return { upsert: (row: Record<string, unknown>) => (rows.push(row), Promise.resolve({ error: null })) };
    },
  } as unknown as SupabaseClient;
  return { admin, rows };
}

Deno.test("PINのロックの知らせ: 社員番号と解除の時刻(日本時間)を出し、メンションはしない", () => {
  const p = pinLockPayload("1234567", "2026-10-15T15:30:00Z");
  assertEquals(p.allowed_mentions.parse, []);
  assertEquals(p.embeds[0].fields[0].value, "1234567");
  assertEquals(p.embeds[0].fields[1].value, "10/16 0:30 ごろ(日本時間)");
});

Deno.test("PINのロックの知らせ: 送れたら90日で消すために記録する。送れなければ記録しない。未設定なら送らない", async () => {
  const posts: unknown[] = [];
  const ok: Discord = { configured: true, post: (p) => (posts.push(p), Promise.resolve({ ok: true, id: "m1" })), remove: () => Promise.resolve({ ok: true, status: 204 }) };
  const a = fakeAdmin();
  await pinLockNotifier(a.admin, ok)("1234567", "2026-10-15T15:30:00Z");
  assertEquals(posts.length, 1);
  assertEquals(a.rows, [{ message_id: "m1", inquiry_id: null }]);

  const ng: Discord = { configured: true, post: () => Promise.resolve({ ok: false, status: 500, error: "x" }), remove: () => Promise.resolve({ ok: false, status: 0 }) };
  const b = fakeAdmin();
  await pinLockNotifier(b.admin, ng)("1234567", "2026-10-15T15:30:00Z");
  assertEquals(b.rows, []);

  let called = false;
  const off: Discord = { configured: false, post: () => (called = true, Promise.resolve({ ok: true, id: "x" })), remove: () => Promise.resolve({ ok: true, status: 204 }) };
  await pinLockNotifier(fakeAdmin().admin, off)("1234567", "2026-10-15T15:30:00Z");
  assert(!called);
});
