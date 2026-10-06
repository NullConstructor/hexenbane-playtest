import { describe, expect, it, vi } from "vitest";
import { AGREEMENT_SHA256, AGREEMENT_VERSION } from "../supabase/functions/_shared/agreement.generated.ts";
import { parseAllowedOrigins } from "../supabase/functions/_shared/cors.ts";
import type { DiscordWebhookPayload } from "../supabase/functions/_shared/discord.ts";
import { type ApplicationStore, createHandler, type InsertResult, type NewApplicationRow } from "../supabase/functions/_shared/handler.ts";
import { generatePublicApplicationId, PUBLIC_ID_PATTERN } from "../supabase/functions/_shared/ids.ts";
import { validInput } from "./fixtures.ts";

const ORIGIN = "https://nullconstructor.github.io";

function setup(opts: { insert?: (row: NewApplicationRow) => InsertResult; notify?: () => Promise<{ ok: boolean; reason?: string }>; captcha?: boolean } = {}) {
  const rows: NewApplicationRow[] = [];
  const notified: string[] = [];
  const payloads: DiscordWebhookPayload[] = [];
  const store: ApplicationStore = {
    ensureAgreementVersion: vi.fn(async () => {}),
    insertApplication: vi.fn(async (row) => {
      const result = opts.insert?.(row) ?? "ok";
      if (result === "ok") rows.push(row);
      return result;
    }),
    markDiscordNotified: vi.fn(async (id) => {
      notified.push(id);
    }),
  };
  const errors: string[] = [];
  const handler = createHandler({
    store,
    notify: async (payload) => {
      payloads.push(payload);
      return (opts.notify ? await opts.notify() : { ok: true }) as { ok: true };
    },
    allowedOrigins: parseAllowedOrigins(`${ORIGIN}/hexenbane-playtest/, http://localhost:5173`),
    captcha: opts.captcha ? { name: "test", verify: async (t) => t === "good" } : null,
    log: { info: () => {}, error: (m) => errors.push(m) },
  });
  return { handler, rows, notified, payloads, store, errors };
}

const post = (body: unknown, init: { origin?: string | null; contentType?: string; method?: string } = {}) => {
  const headers: Record<string, string> = { "Content-Type": init.contentType ?? "application/json" };
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
  return new Request("https://x.supabase.co/functions/v1/submit-playtest-application", {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" || init.method === "OPTIONS" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
};
const submission = (overrides: Record<string, unknown> = {}) => ({ ...validInput(), website: "", elapsedMs: 45000, ...overrides });

describe("submit-playtest-application", () => {
  it("stores a valid application and returns only success and the application ID", async () => {
    const { handler, rows, notified } = setup();
    const res = await handler(post(submission()));
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["applicationId", "success"]);
    expect(body.applicationId).toMatch(PUBLIC_ID_PATTERN);
    expect(rows).toHaveLength(1);
    expect(notified).toEqual([body.applicationId]);
  });

  it("ignores any agreement version, hash or status the browser sends", async () => {
    const { handler, rows } = setup();
    await handler(post(submission({ agreementVersion: "FAKE-v99", agreementHash: "0".repeat(64), agreement_version: "x", status: "approved", agreementAcceptedAt: "1999-01-01" })));
    expect(rows[0].agreement_version).toBe(AGREEMENT_VERSION);
    expect(rows[0].agreement_hash).toBe(AGREEMENT_SHA256);
    expect(rows[0]).not.toHaveProperty("status");
    expect(new Date(rows[0].agreement_accepted_at).getFullYear()).toBeGreaterThan(2000);
  });

  it("refuses submissions without agreement", async () => {
    const { handler, rows } = setup();
    const res = await handler(post(submission({ agreementAccepted: false })));
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.agreementAccepted).toBeTruthy();
    expect(rows).toHaveLength(0);
  });

  it("rejects honeypot and too-fast submissions without storing them", async () => {
    const { handler, rows } = setup();
    expect((await handler(post(submission({ website: "spam" })))).status).toBe(400);
    expect((await handler(post(submission({ elapsedMs: 200 })))).status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it("reports a duplicate Discord username as 409", async () => {
    const { handler } = setup({ insert: () => "duplicate_discord" });
    const res = await handler(post(submission()));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("duplicate");
  });

  it("retries on an application ID collision", async () => {
    let calls = 0;
    const { handler, rows } = setup({ insert: () => (++calls === 1 ? "duplicate_public_id" : "ok") });
    expect((await handler(post(submission()))).status).toBe(201);
    expect(calls).toBe(2);
    expect(rows).toHaveLength(1);
  });

  it("still succeeds when Discord fails after the application is stored", async () => {
    const failing = setup({ notify: async () => ({ ok: false, reason: "Discord answered 500" }) });
    const res = await failing.handler(post(submission()));
    expect(res.status).toBe(201);
    expect(failing.rows).toHaveLength(1);
    expect(failing.notified).toHaveLength(0);
    expect(failing.errors.some((e) => e.includes("discord notification failed"))).toBe(true);

    const throwing = setup({ notify: async () => { throw new Error("boom"); } });
    expect((await throwing.handler(post(submission()))).status).toBe(201);
  });

  it("returns a server error, not success, when storing fails", async () => {
    const { handler } = setup({ insert: () => { throw new Error("db down"); } });
    const res = await handler(post(submission()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });

  it("enforces CORS origins", async () => {
    const { handler, rows } = setup();
    expect((await handler(post(submission(), { origin: "https://evil.example" }))).status).toBe(403);
    expect((await handler(post(submission(), { origin: null }))).status).toBe(403);
    const preflight = await handler(post(null, { method: "OPTIONS", origin: "http://localhost:5173" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(rows).toHaveLength(0);
  });

  it("accepts POST with JSON only", async () => {
    const { handler } = setup();
    expect((await handler(post(null, { method: "GET" }))).status).toBe(405);
    expect((await handler(post("a=b", { contentType: "application/x-www-form-urlencoded" }))).status).toBe(415);
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(post("[1,2]"))).status).toBe(400);
  });

  it("refuses oversized bodies", async () => {
    const { handler } = setup();
    const res = await handler(post(submission({ additionalNotes: "x".repeat(40000) })));
    expect(res.status).toBe(413);
  });

  it("checks the CAPTCHA when one is configured", async () => {
    const { handler, rows } = setup({ captcha: true });
    expect((await handler(post(submission({ captchaToken: "bad" })))).status).toBe(400);
    expect((await handler(post(submission({ captchaToken: "good" })))).status).toBe(201);
    expect(rows).toHaveLength(1);
  });

  it("puts no mention-capable payload in the Discord message", async () => {
    const { handler, payloads } = setup();
    await handler(post(submission({ preferredName: "@everyone", interestReason: "Ping <@&1234567890123> @here please" })));
    expect(payloads[0].allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(payloads[0])).not.toMatch(/@everyone|@here|<@&\d+>/);
  });
});

describe("public application IDs", () => {
  it("look like HEX-PT-XXXXXX and avoid ambiguous characters", () => {
    for (let i = 0; i < 500; i++) {
      const id = generatePublicApplicationId();
      expect(id).toMatch(PUBLIC_ID_PATTERN);
      expect(id.slice(7)).not.toMatch(/[01OILSU5V]/);
    }
  });
});

describe("parseAllowedOrigins", () => {
  it("reduces URLs to origins and defaults to localhost only", () => {
    expect(parseAllowedOrigins("https://name.github.io/hexenbane-playtest/, ,nonsense")).toEqual(["https://name.github.io"]);
    expect(parseAllowedOrigins(undefined).every((o) => o.includes("localhost") || o.includes("127.0.0.1"))).toBe(true);
  });
});
