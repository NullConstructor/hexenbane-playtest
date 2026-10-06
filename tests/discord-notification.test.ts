import { describe, expect, it, vi } from "vitest";
import {
  buildApplicationEmbed,
  EMBED_LIMITS,
  isDiscordWebhookUrl,
  neutralizeForDiscord,
  sendDiscordWebhook,
  truncate,
} from "../supabase/functions/_shared/discord.ts";
import { validInput } from "./fixtures.ts";

const app = (overrides: Record<string, unknown> = {}) => ({
  ...validInput(),
  email: null,
  additionalNotes: null,
  joinedDiscord: true as const,
  agreementAccepted: true as const,
  publicApplicationId: "HEX-PT-7KQ3XM",
  agreementVersion: "HEXENBANE-PLAYTEST-2026-10-v1",
  submittedAt: "2026-10-06T03:00:00.000Z",
  ...overrides,
});

const embedText = (payload: ReturnType<typeof buildApplicationEmbed>) =>
  JSON.stringify(payload.embeds.map((e) => [e.title, e.description, e.footer.text, e.fields]));

describe("Discord mention safety", () => {
  it("always disables every kind of mention", () => {
    expect(buildApplicationEmbed(app()).allowed_mentions).toEqual({ parse: [] });
  });

  it("breaks @everyone, @here, user, role and channel mentions in applicant text", () => {
    const evil = "@everyone @here <@123456789012345678> <@!123456789012345678> <@&123456789012345678> <#123456789012345678>";
    const payload = buildApplicationEmbed(app({ preferredName: evil.slice(0, 60), interestReason: evil, additionalNotes: evil }));
    const text = embedText(payload);
    expect(text).not.toMatch(/@everyone|@here/);
    expect(text).not.toMatch(/<@!?\d+>|<@&\d+>|<#\d+>/);
  });

  it("neutralises masked links and raw URLs", () => {
    const out = neutralizeForDiscord("[free nitro](https://evil.example) https://evil.example");
    expect(out).not.toContain("](");
    expect(out).not.toContain("https://");
  });
});

describe("embed limits", () => {
  it("keeps every field and the whole embed within Discord's limits", () => {
    const long = "ꙮ".repeat(1500);
    const payload = buildApplicationEmbed(app({ interestReason: long, similarGames: long, testingExperience: long, additionalNotes: long, cpu: "c".repeat(120) }));
    const embed = payload.embeds[0];
    let total = embed.title.length + embed.description.length + embed.footer.text.length;
    for (const f of embed.fields) {
      expect(Array.from(f.value).length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
      expect(f.name.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldName);
      total += f.name.length + f.value.length;
    }
    expect(embed.fields.length).toBeLessThanOrEqual(EMBED_LIMITS.fields);
    expect(total).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });

  it("shows the application ID, agreement version and pending status", () => {
    const text = embedText(buildApplicationEmbed(app()));
    expect(text).toContain("HEX-PT-7KQ3XM");
    expect(text).toContain("HEXENBANE");
    expect(text).toContain("PENDING");
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});

describe("sendDiscordWebhook", () => {
  const url = "https://discord.com/api/webhooks/123456789012345678/abcDEF-123_xyz";

  it("recognises real webhook URLs only", () => {
    expect(isDiscordWebhookUrl(url)).toBe(true);
    expect(isDiscordWebhookUrl("https://evil.example/api/webhooks/1/x")).toBe(false);
  });

  it("posts JSON with wait=true and reports success", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await sendDiscordWebhook(url, buildApplicationEmbed(app()), fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${url}?wait=true`, expect.objectContaining({ method: "POST" }));
  });

  it("never throws and never echoes the webhook URL", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const r1 = await sendDiscordWebhook(url, buildApplicationEmbed(app()), failing as unknown as typeof fetch);
    expect(r1.ok).toBe(false);
    const r2 = await sendDiscordWebhook(url, buildApplicationEmbed(app()), (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    expect(r2.ok).toBe(false);
    const r3 = await sendDiscordWebhook(undefined, buildApplicationEmbed(app()));
    expect(r3.ok).toBe(false);
    for (const r of [r1, r2, r3]) if (!r.ok) expect(r.reason).not.toContain("abcDEF");
  });
});
