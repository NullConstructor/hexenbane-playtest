// End-to-end test of the game's endpoints (ingest-telemetry, submit-crash, submit-feedback)
// against a real database, with a fake Discord. Same setup as e2e.test.ts:
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
//     deno test --allow-env --allow-net --config supabase/functions/submit-playtest-application/deno.json supabase/tests/game-e2e.test.ts
//
// Every row it creates uses a fresh random install id and is deleted at the end.

import { createClient } from "@supabase/supabase-js";
import { createCrashHandler, type ForumNotifier } from "../functions/_shared/crash.ts";
import type { ForumPostPayload } from "../functions/_shared/discord-forum.ts";
import { createFeedbackHandler } from "../functions/_shared/feedback.ts";
import {
  createCrashStore,
  createFeedbackStore,
  createRateLimiter,
  createTelemetryStore,
} from "../functions/_shared/game-store.ts";
import { createTelemetryHandler } from "../functions/_shared/telemetry.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "game endpoints against a real database",
  ignore: !url || !key,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
    const log = { info: () => {}, error: () => {} };
    const limiter = createRateLimiter(db);
    const installId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const posts: ForumPostPayload[] = [];
    let discordUp = true;
    const notify: ForumNotifier = (payload) => {
      posts.push(payload);
      return Promise.resolve(discordUp ? { ok: true } : { ok: false, reason: "Discord answered 500" });
    };
    const signatures: string[] = [];

    const call = async (handler: (r: Request) => Promise<Response>, body: unknown) => {
      const response = await handler(
        new Request("http://function/game", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Hexenbane-Build": "0.8.0", "x-forwarded-for": "192.0.2.10" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, json: await response.json() };
    };

    try {
      await t.step("telemetry is stored once, even when the batch is retried", async () => {
        const handler = createTelemetryHandler({ store: createTelemetryStore(db), limiter, ipSalt: "e2e-salt", log });
        const batch = {
          install_id: installId,
          session_id: sessionId,
          version: "0.8.0",
          events: [
            { name: "hunt_start", seq: 0, at: "2026-10-08T12:00:00Z", data: { hunt_id: "h1", coven: "Ash", implements: ["b", "a"] } },
            {
              name: "fight_end",
              seq: 1,
              at: "2026-10-08T12:01:00Z",
              data: { quarry: "e2e-quarry", night: 1, result: "win", beats: 8, vitality_start: 30, vitality_end: 20, mode: "hunt", cards_played: { "e2e-card": 2 }, hunt_id: "h1" },
            },
            { name: "card_offer", seq: 2, at: "2026-10-08T12:02:00Z", data: { source: "fight", offered: ["e2e-card", "e2e-other"], taken: "e2e-card", hunt_id: "h1" } },
            { name: "hunt_end", seq: 3, at: "2026-10-08T12:03:00Z", data: { hunt_id: "h1", result: "lost", night: 2, killed_by: "e2e-quarry" } },
          ],
        };
        const first = await call(handler, batch);
        assert(first.status === 200 && first.json.accepted === 4 && first.json.duplicates === 0, `first: ${JSON.stringify(first)}`);
        const retry = await call(handler, batch);
        assert(retry.status === 200 && retry.json.duplicates === 4, `retry: ${JSON.stringify(retry)}`);
        const { count } = await db.from("telemetry_events").select("id", { count: "exact", head: true }).eq("install_id", installId);
        assert(count === 4, `expected 4 rows, got ${count}`);

        const { data: balance } = await db.from("quarry_balance").select("*").eq("quarry", "e2e-quarry").single();
        assert(balance && Number(balance.fights) >= 1 && Number(balance.avg_vitality_lost) > 0, "quarry_balance row");
        const { data: card } = await db.from("card_stats").select("*").eq("card_id", "e2e-card").single();
        assert(card && Number(card.offered) >= 1 && Number(card.taken) >= 1, "card_stats row");
        const { data: pair } = await db.from("implement_pairs").select("*").eq("coven", "Ash").eq("implements", "a + b");
        assert(pair && pair.length === 1, "implement_pairs row (pair sorted)");
        const { data: deaths } = await db.from("death_causes").select("*").eq("killed_by", "e2e-quarry");
        assert(deaths && deaths.length === 1, "death_causes row");
      });

      await t.step("a crash is stored every time but posted once", async () => {
        const handler = createCrashHandler({ store: createCrashStore(db), limiter, ipSalt: "e2e-salt", log, notify, tags: {} });
        const crash = {
          install_id: installId,
          session_id: sessionId,
          version: "0.8.0",
          kind: "crash",
          message: `E2E crash ${crypto.randomUUID().replace(/\d/g, "")}`,
          stack: "res://e2e.gd:1 - in function _ready",
          log_tail: "log line\n",
          occurred_at: "2026-10-08T12:04:00Z",
          context: { os: "Test OS", gpu: "Test GPU", window: "1280x720", scene: "E2E" },
        };
        const before = posts.length;
        const a = await call(handler, crash);
        const b = await call(handler, crash);
        assert(a.status === 200 && a.json.posted === true, `first crash: ${JSON.stringify(a)}`);
        assert(b.status === 200 && b.json.posted === false, `second crash: ${JSON.stringify(b)}`);
        assert(posts.length === before + 1, "exactly one forum post");
        const { data } = await db.from("crash_reports").select("signature").eq("install_id", installId);
        assert(data && data.length === 2 && data[0].signature === data[1].signature, "two rows, same signature");
        signatures.push(data[0].signature);
        const { data: summary } = await db.from("crash_summary").select("*").eq("signature", data[0].signature).single();
        assert(summary && Number(summary.reports) === 2 && summary.discord_posted_at, "crash_summary counts both");
      });

      await t.step("feedback answers 200 when Discord accepts and 502 when it does not", async () => {
        const handler = createFeedbackHandler({ store: createFeedbackStore(db), limiter, ipSalt: "e2e-salt", log, notify, tags: {} });
        const report = {
          install_id: installId,
          version: "0.8.0",
          kind: "UI",
          title: "E2E report",
          details: "Testing.",
          context: { version: "0.8.0", scene: "E2E", os: "Test OS", gpu: "Test GPU", window: "1280x720", time_utc: "2026-10-08T12:05:00Z" },
        };
        const ok = await call(handler, report);
        assert(ok.status === 200 && /^BR-/.test(ok.json.id), `feedback ok: ${JSON.stringify(ok)}`);
        discordUp = false;
        const failed = await call(handler, report);
        discordUp = true;
        assert(failed.status === 502 && failed.json.ok === false, `feedback failed: ${JSON.stringify(failed)}`);
        const { data } = await db.from("feedback_reports").select("report_id, discord_ok").eq("install_id", installId);
        const byId = new Map((data ?? []).map((r) => [r.report_id, r.discord_ok]));
        assert(byId.get(ok.json.id) === true && byId.get(failed.json.id) === false, "discord_ok recorded per row");
      });

      await t.step("the rate limiter refuses past the limit", async () => {
        const rule = { bucket: "e2e:test", limit: 2, windowSeconds: 600 };
        const results = [];
        for (let i = 0; i < 3; i++) results.push(await limiter.hit(rule, installId));
        assert(results[0].allowed && results[1].allowed && !results[2].allowed, JSON.stringify(results));
        assert(results[2].retryAfter >= 1 && results[2].retryAfter <= 600, "retry_after within the window");
      });

      if (anonKey) {
        await t.step("the public anon key can read, write and call none of it", async () => {
          const anon = createClient(url!, anonKey, { auth: { persistSession: false } });
          for (const table of ["telemetry_events", "crash_reports", "crash_signatures", "feedback_reports", "game_rate_limits", "quarry_balance", "crash_summary"]) {
            const read = await anon.from(table).select("*").limit(1);
            assert(read.error, `anon read of ${table} should be refused`);
          }
          const insert = await anon.from("telemetry_events").insert({ install_id: installId });
          assert(insert.error, "anon insert should be refused");
          const rpc = await anon.rpc("game_rate_limit_hit", { p_bucket: "x", p_subject: "x", p_limit: 1, p_window_seconds: 60 });
          assert(rpc.error, "anon rpc should be refused");
        });
      }
    } finally {
      await db.from("telemetry_events").delete().eq("install_id", installId);
      await db.from("crash_reports").delete().eq("install_id", installId);
      await db.from("feedback_reports").delete().eq("install_id", installId);
      if (signatures.length) await db.from("crash_signatures").delete().in("signature", signatures);
      await db.from("game_rate_limits").delete().eq("subject", installId);
    }
  },
});
