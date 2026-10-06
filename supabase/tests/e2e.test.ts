// End-to-end test of the Edge Function's handler against a real database.
//
// Runs the real handler and the real supabase-js store against a running Supabase (local
// `supabase start` or any project you are happy to write test rows to), with a fake Discord.
// Rows it creates are deleted at the end.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
//     deno test --allow-env --allow-net --config supabase/functions/submit-playtest-application/deno.json supabase/tests/e2e.test.ts
//
// (`npm run test:e2e` does the same, reading the two values from your environment.)

import { createClient } from "@supabase/supabase-js";
import { AGREEMENT_SHA256, AGREEMENT_VERSION } from "../functions/_shared/agreement.generated.ts";
import type { DiscordWebhookPayload, NotifyResult } from "../functions/_shared/discord.ts";
import { createHandler } from "../functions/_shared/handler.ts";
import { createSupabaseStore } from "../functions/_shared/supabase-store.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const ORIGIN = "http://localhost:5173";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "submit-playtest-application against a real database",
  ignore: !url || !key,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
    const sent: DiscordWebhookPayload[] = [];
    let discordUp = true;
    const handler = createHandler({
      store: createSupabaseStore(db),
      notify: (payload): Promise<NotifyResult> => {
        sent.push(payload);
        return Promise.resolve(discordUp ? { ok: true } : { ok: false, reason: "Discord answered 500" });
      },
      allowedOrigins: [ORIGIN],
      log: { info: () => {}, error: () => {} },
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const created: string[] = [];

    const submit = async (overrides: Record<string, unknown> = {}) => {
      const body = {
        preferredName: "E2E Hunter",
        discordUsername: `e2e_${suffix}`,
        email: "",
        interestReason: "I want to hunt witches with a deck of cards.",
        similarGames: "Slay the Spire, Inscryption",
        testingExperience: "Plenty",
        cpu: "Ryzen 7 5800X",
        gpu: "RTX 3070",
        ram: "32 GB",
        operatingSystem: "Windows 11",
        additionalNotes: "",
        joinedDiscord: true,
        agreementAccepted: true,
        website: "",
        elapsedMs: 60000,
        ...overrides,
      };
      const response = await handler(
        new Request("http://function/submit-playtest-application", {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const json = await response.json();
      if (json.success) created.push(json.applicationId);
      return { status: response.status, json };
    };

    try {
      await t.step("stores a valid application with the server's agreement version", async () => {
        const { status, json } = await submit({
          // A forged agreement claim must be ignored.
          agreementVersion: "HEXENBANE-PLAYTEST-2099-01-v9",
          agreementHash: "0".repeat(64),
          status: "approved",
        });
        assert(status === 201, `expected 201, got ${status} ${JSON.stringify(json)}`);
        assert(/^HEX-PT-[A-Z0-9]{6}$/.test(json.applicationId), "application ID format");
        assert(Object.keys(json).sort().join() === "applicationId,success", "response exposes only success + applicationId");

        const { data, error } = await db.from("playtest_applications").select("*").eq("public_application_id", json.applicationId).single();
        assert(!error, `select failed: ${error?.message}`);
        assert(data.agreement_version === AGREEMENT_VERSION, "agreement_version is the server's");
        assert(data.agreement_hash === AGREEMENT_SHA256, "agreement_hash is the server's");
        assert(data.agreement_accepted === true && data.agreement_accepted_at, "agreement acceptance recorded");
        assert(data.status === "pending", "status starts pending whatever the client sent");
        assert(data.email === null && data.additional_notes === null, "empty optional fields stored as null");
        assert(data.discord_notified_at !== null, "discord_notified_at set after a delivered notification");
        assert(sent.length === 1 && sent[0].allowed_mentions.parse.length === 0, "one notification, mentions disabled");

        const { data: version } = await db.from("playtest_agreement_versions").select("sha256, body").eq("version", AGREEMENT_VERSION).single();
        assert(version?.sha256 === AGREEMENT_SHA256 && version.body.length > 100, "agreement text recorded");
      });

      await t.step("refuses a repeat application for the same Discord username", async () => {
        const { status, json } = await submit({ discordUsername: `@E2E_${suffix.toUpperCase()}` });
        assert(status === 409 && json.error.code === "duplicate", `expected 409 duplicate, got ${status}`);
      });

      await t.step("keeps the application when Discord is down", async () => {
        discordUp = false;
        const { status, json } = await submit({ discordUsername: `e2e_${suffix}_b` });
        discordUp = true;
        assert(status === 201, `expected 201, got ${status}`);
        const { data } = await db.from("playtest_applications").select("discord_notified_at").eq("public_application_id", json.applicationId).single();
        assert(data && data.discord_notified_at === null, "stored without discord_notified_at");
      });

      await t.step("stores nothing for a honeypot hit", async () => {
        const before = created.length;
        const { status } = await submit({ discordUsername: `e2e_${suffix}_c`, website: "http://spam.example" });
        assert(status === 400 && created.length === before, "honeypot refused");
        const { count } = await db.from("playtest_applications").select("id", { count: "exact", head: true })
          .eq("discord_username_normalized", `e2e_${suffix}_c`);
        assert(count === 0, "no row written");
      });

      if (anonKey) {
        await t.step("the public anon key can neither read nor write applications", async () => {
          const anon = createClient(url!, anonKey, { auth: { persistSession: false } });
          const read = await anon.from("playtest_applications").select("*").limit(1);
          assert(read.error || (read.data ?? []).length === 0, "anon read returned rows");
          assert(read.error, "anon read should be refused outright");
          const write = await anon.from("playtest_applications").insert({ public_application_id: "HEX-PT-ZZZZZZ" });
          assert(write.error, "anon insert should be refused");
        });
      }
    } finally {
      if (created.length) await db.from("playtest_applications").delete().in("public_application_id", created);
    }
  },
});
