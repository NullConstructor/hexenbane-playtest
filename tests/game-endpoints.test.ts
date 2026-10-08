import { describe, expect, it } from "vitest";
import { createCrashHandler, type CrashRow, type ForumNotifier } from "../supabase/functions/_shared/crash.ts";
import type { ForumFile, ForumPostPayload } from "../supabase/functions/_shared/discord-forum.ts";
import { createFeedbackHandler, type FeedbackRow } from "../supabase/functions/_shared/feedback.ts";
import type { RateLimiter, RateLimitRule } from "../supabase/functions/_shared/game-http.ts";
import { createTelemetryHandler, type TelemetryRow } from "../supabase/functions/_shared/telemetry.ts";
import { crashBody, feedbackBody, INSTALL_ID, jpegBase64, telemetryBody } from "./fixtures.ts";

const IP = "203.0.113.77";

/** Counts hits per bucket+subject like the database function, remembering every subject seen. */
function fakeLimiter() {
  const counts = new Map<string, number>();
  const subjects: string[] = [];
  const limiter: RateLimiter = {
    hit: async (rule: RateLimitRule, subject: string) => {
      subjects.push(subject);
      const k = `${rule.bucket}|${subject}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return { allowed: n <= rule.limit, retryAfter: 120 };
    },
  };
  return { limiter, subjects };
}

const quietLog = { info: () => {}, error: () => {} };

const request = (
  path: string,
  body: unknown,
  init: { build?: string | null; contentType?: string; method?: string; ip?: string } = {},
) => {
  const headers: Record<string, string> = {
    "Content-Type": init.contentType ?? "application/json",
    "x-forwarded-for": `${init.ip ?? IP}, 10.0.0.1`,
  };
  if (init.build !== null) headers["X-Hexenbane-Build"] = init.build ?? "0.8.0";
  const method = init.method ?? "POST";
  return new Request(`https://x.supabase.co/functions/v1/${path}`, {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
};

function telemetrySetup() {
  const stored = new Map<string, TelemetryRow>();
  const { limiter, subjects } = fakeLimiter();
  const handler = createTelemetryHandler({
    limiter,
    ipSalt: "test-salt",
    log: quietLog,
    store: {
      insertEvents: async (rows) => {
        let inserted = 0;
        for (const row of rows) {
          const key = `${row.session_id}|${row.seq}`;
          if (!stored.has(key)) {
            stored.set(key, row);
            inserted++;
          }
        }
        return inserted;
      },
    },
  });
  return { handler, stored, subjects };
}

describe("ingest-telemetry", () => {
  it("stores a batch and answers ok with the count", async () => {
    const { handler, stored } = telemetrySetup();
    const res = await handler(request("ingest-telemetry", telemetryBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2, duplicates: 0 });
    expect(stored.size).toBe(2);
  });

  it("does not double-count a retried batch", async () => {
    const { handler, stored } = telemetrySetup();
    await handler(request("ingest-telemetry", telemetryBody()));
    const res = await handler(request("ingest-telemetry", telemetryBody()));
    expect(await res.json()).toEqual({ ok: true, accepted: 2, duplicates: 2 });
    expect(stored.size).toBe(2);
  });

  it("requires POST, JSON and a valid build header", async () => {
    const { handler, stored } = telemetrySetup();
    expect((await handler(request("ingest-telemetry", null, { method: "GET" }))).status).toBe(405);
    expect((await handler(request("ingest-telemetry", telemetryBody(), { contentType: "text/plain" }))).status).toBe(415);
    expect((await handler(request("ingest-telemetry", telemetryBody(), { build: null }))).status).toBe(400);
    expect((await handler(request("ingest-telemetry", telemetryBody(), { build: "x".repeat(33) }))).status).toBe(400);
    expect((await handler(request("ingest-telemetry", "{oops"))).status).toBe(400);
    const invalid = await handler(request("ingest-telemetry", telemetryBody({ install_id: "nope" })));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, error: "validation_failed", fields: { install_id: expect.any(String) } });
    expect(stored.size).toBe(0);
  });

  it("answers OPTIONS harmlessly, without CORS permission", async () => {
    const { handler } = telemetrySetup();
    const res = await handler(request("ingest-telemetry", null, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("refuses bodies over 512 KB with 413", async () => {
    const { handler } = telemetrySetup();
    const res = await handler(request("ingest-telemetry", { padding: "x".repeat(520 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("rate-limits per install (60 per 10 minutes) and never sees the raw IP", async () => {
    const { handler, subjects } = telemetrySetup();
    for (let i = 0; i < 60; i++) {
      const body = telemetryBody({ events: [{ name: "purchase", seq: i, at: "2026-10-08T12:00:00Z", data: {} }] });
      expect((await handler(request("ingest-telemetry", body, { ip: `198.51.100.${i}` }))).status).toBe(200);
    }
    const res = await handler(request("ingest-telemetry", telemetryBody(), { ip: "198.51.100.200" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(subjects.some((s) => s.includes("198.51.100") || s.includes(IP))).toBe(false);
    expect(subjects.filter((s) => /^[0-9a-f]{64}$/.test(s)).length).toBeGreaterThan(0);
  });

  it("keeps working, without IP limits, when the limiter or salt is missing", async () => {
    const handler = createTelemetryHandler({
      limiter: { hit: () => Promise.reject(new Error("db down")) },
      ipSalt: null,
      log: quietLog,
      store: { insertEvents: async (rows) => rows.length },
    });
    expect((await handler(request("ingest-telemetry", telemetryBody()))).status).toBe(200);
  });

  it("returns 500 without details when storing fails", async () => {
    const handler = createTelemetryHandler({
      limiter: fakeLimiter().limiter,
      log: quietLog,
      store: { insertEvents: () => Promise.reject(new Error("secret db detail")) },
    });
    const res = await handler(request("ingest-telemetry", telemetryBody()));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret db detail");
  });
});

function crashSetup(opts: { notify?: ForumNotifier | null; discordOk?: boolean } = {}) {
  const rows: CrashRow[] = [];
  const seen = new Map<string, { count: number; posted: boolean }>();
  const posts: Array<{ payload: ForumPostPayload; files: ForumFile[] }> = [];
  const notify: ForumNotifier | null = opts.notify !== undefined ? opts.notify : async (payload, files) => {
    posts.push({ payload, files });
    return opts.discordOk === false ? { ok: false, reason: "Discord answered 500" } : { ok: true };
  };
  const handler = createCrashHandler({
    limiter: fakeLimiter().limiter,
    ipSalt: "salt",
    log: quietLog,
    notify,
    tags: { New: "111111", Crash: "222222", UI: "333333" },
    store: {
      insertCrash: async (row) => {
        rows.push(row);
        return "ok";
      },
      recordSignature: async (signature, _version, claim) => {
        const entry = seen.get(signature) ?? { count: 0, posted: false };
        entry.count++;
        seen.set(signature, entry);
        return { seen: entry.count, notify: claim && !entry.posted };
      },
      markSignaturePosted: async (signature) => {
        seen.get(signature)!.posted = true;
      },
    },
  });
  return { handler, rows, posts };
}

describe("submit-crash", () => {
  it("stores every report but posts each crash signature only once", async () => {
    const { handler, rows, posts } = crashSetup();
    const first = await handler(request("submit-crash", crashBody()));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, id: expect.stringMatching(/^CR-/), posted: true });
    const again = await handler(request("submit-crash", crashBody({ message: "Invalid get index 'hp' (on base: 'Nil') at 0x7ff600000001" })));
    expect(await again.json()).toMatchObject({ ok: true, posted: false });
    expect(rows).toHaveLength(2);
    expect(rows[0].signature).toBe(rows[1].signature);
    expect(posts).toHaveLength(1);

    const { payload, files } = posts[0];
    expect(payload.thread_name.startsWith("[Crash] ")).toBe(true);
    expect(payload.thread_name.length).toBeLessThanOrEqual(100);
    expect(payload.applied_tags).toEqual(["111111", "222222"]);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(files.map((f) => f.filename)).toEqual(["crash-log.txt"]);
    expect(JSON.stringify(payload.embeds[0].fields)).toContain("First report");
  });

  it("retries the post on a later report when Discord failed", async () => {
    const { handler, posts } = crashSetup({ discordOk: false });
    await handler(request("submit-crash", crashBody()));
    const res = await handler(request("submit-crash", crashBody()));
    expect(res.status).toBe(200);
    expect(posts).toHaveLength(2);
  });

  it("only stores when no webhook is configured", async () => {
    const { handler, rows } = crashSetup({ notify: null });
    const res = await handler(request("submit-crash", crashBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, posted: false });
    expect(rows).toHaveLength(1);
  });

  it("neutralises mentions in the thread name and embed", async () => {
    const { handler, posts } = crashSetup();
    await handler(request("submit-crash", crashBody({ message: "@everyone <@&123456789012345678> crashed" })));
    const text = JSON.stringify(posts[0].payload);
    expect(text).not.toMatch(/@everyone|<@&\d+>/);
  });

  it("rate-limits crash reports to 20 per hour per install", async () => {
    const { handler } = crashSetup({ notify: null });
    for (let i = 0; i < 20; i++) expect((await handler(request("submit-crash", crashBody()))).status).toBe(200);
    expect((await handler(request("submit-crash", crashBody()))).status).toBe(429);
  });
});

function feedbackSetup(opts: { notify?: ForumNotifier | null; discordOk?: boolean } = {}) {
  const rows: FeedbackRow[] = [];
  const posted: string[] = [];
  const posts: Array<{ payload: ForumPostPayload; files: ForumFile[] }> = [];
  const notify: ForumNotifier | null = opts.notify !== undefined ? opts.notify : async (payload, files) => {
    posts.push({ payload, files });
    return opts.discordOk === false ? { ok: false, reason: "Discord answered 400" } : { ok: true };
  };
  const { limiter } = fakeLimiter();
  const handler = createFeedbackHandler({
    limiter,
    ipSalt: "salt",
    log: quietLog,
    notify,
    tags: { New: "111111", Crash: "222222", UI: "333333", Combat: "444444" },
    store: {
      insertFeedback: async (row) => {
        rows.push(row);
        return "ok";
      },
      markDiscordPosted: async (id) => {
        posted.push(id);
      },
    },
  });
  return { handler, rows, posted, posts };
}

describe("submit-feedback", () => {
  it("posts to the forum with screenshot and log, stores the row without the bytes", async () => {
    const { handler, rows, posted, posts } = feedbackSetup();
    const res = await handler(request("submit-feedback", feedbackBody({ screenshot_jpg: jpegBase64(), log: "the log" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: expect.stringMatching(/^BR-[A-Z0-9]{6}$/) });
    expect(rows[0]).toMatchObject({ kind: "Bug", has_screenshot: true, has_log: true, install_id: INSTALL_ID });
    expect(JSON.stringify(rows[0])).not.toContain(jpegBase64().slice(0, 12));
    expect(posted).toEqual([body.id]);

    const { payload, files } = posts[0];
    expect(payload.thread_name).toBe("Card art overlaps the beat counter");
    expect(payload.applied_tags).toEqual(["111111"]);
    expect(files.map((f) => f.filename)).toEqual(["screenshot.jpg", "game-log.txt"]);
    expect(payload.embeds[0].image).toEqual({ url: "attachment://screenshot.jpg" });
    expect(payload.embeds[0].footer.text).toContain(body.id);
    const fieldNames = payload.embeds[0].fields.map((f) => f.name);
    expect(fieldNames).toEqual(["Kind", "Version", "Where", "PC"]);
    expect(payload.embeds[0].fields[2].value).toContain("Night 2");
  });

  it("applies the kind's tag: Crash→Crash, UI→UI, Balance→Combat", async () => {
    const { handler, posts } = feedbackSetup();
    for (const kind of ["Crash", "UI", "Balance", "Other"]) await handler(request("submit-feedback", feedbackBody({ kind })));
    expect(posts.map((p) => p.payload.applied_tags)).toEqual([
      ["111111", "222222"],
      ["111111", "333333"],
      ["111111", "444444"],
      ["111111"],
    ]);
  });

  it("answers 502 but keeps the row when Discord refuses", async () => {
    const { handler, rows, posted } = feedbackSetup({ discordOk: false });
    const res = await handler(request("submit-feedback", feedbackBody()));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "discord_failed", id: expect.stringMatching(/^BR-/) });
    expect(rows).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });

  it("answers 502 when no webhook is configured", async () => {
    const { handler, rows } = feedbackSetup({ notify: null });
    expect((await handler(request("submit-feedback", feedbackBody()))).status).toBe(502);
    expect(rows).toHaveLength(1);
  });

  it("refuses a non-JPEG screenshot", async () => {
    const { handler, rows } = feedbackSetup();
    const png = Buffer.from("\x89PNG\r\n\x1a\nxxxx").toString("base64");
    const res = await handler(request("submit-feedback", feedbackBody({ screenshot_jpg: png })));
    expect(res.status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it("rate-limits to 10 reports per hour per install and 30 per IP", async () => {
    const { handler } = feedbackSetup();
    for (let i = 0; i < 10; i++) expect((await handler(request("submit-feedback", feedbackBody()))).status).toBe(200);
    expect((await handler(request("submit-feedback", feedbackBody()))).status).toBe(429);

    const ip = feedbackSetup();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const install = `3f2b8c1e-4d5a-4b6c-8d7e-${String(i).padStart(12, "0")}`;
      last = (await ip.handler(request("submit-feedback", feedbackBody({ install_id: install }), { ip: "192.0.2.1" }))).status;
    }
    expect(last).toBe(429);
  });

  it("puts no mention-capable text in the post", async () => {
    const { handler, posts } = feedbackSetup();
    await handler(request("submit-feedback", feedbackBody({
      title: "@here look <@123456789012345678>",
      details: "@everyone [free nitro](https://evil.example)",
    })));
    const text = JSON.stringify(posts[0].payload);
    expect(text).not.toMatch(/@everyone|@here|<@\d+>/);
    expect(text).not.toContain("](");
  });
});
