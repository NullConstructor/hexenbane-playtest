// Builds and sends the #playtest-applications notification.
//
// Applicant text is untrusted. Two layers stop it from pinging anyone:
//   1. every webhook call sends allowed_mentions: { parse: [] }, which tells Discord to ignore
//      all @everyone, @here, role and user mentions in the message;
//   2. mention syntax and markdown are also neutralised in the text itself, so a copy-paste of
//      the embed elsewhere stays harmless and nobody can fake links or formatting.

import type { ApplicationInput } from "./application.ts";

// Discord's documented embed limits.
export const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  fields: 25,
  total: 6000,
} as const;

const ZERO_WIDTH_SPACE = "​";
const EMBED_COLOR = 0x5b3f99; // Hexenbane violet

/** Cuts text to `max` code points, ending with an ellipsis when it had to cut. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/**
 * Makes applicant text inert in Discord: breaks @everyone/@here, user/role/channel mention
 * syntax and invite-style masked links, and escapes markdown so it renders literally.
 */
export function neutralizeForDiscord(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([*_~`|>[\]()#-])/g, "\\$1")
    .replace(/<(@[!&]?|#|\/|a?:)/g, `<${ZERO_WIDTH_SPACE}$1`)
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/https?:\/\//gi, (m) => m.replace("//", `/${ZERO_WIDTH_SPACE}/`));
}

function safe(text: string | null | undefined, max: number, fallback = "—"): string {
  const value = text && text.trim() ? neutralizeForDiscord(text.trim()) : fallback;
  return truncate(value, max) || fallback;
}

export interface NotificationApplication extends ApplicationInput {
  publicApplicationId: string;
  agreementVersion: string;
  submittedAt: string; // ISO 8601 UTC
}

export interface DiscordWebhookPayload {
  username: string;
  allowed_mentions: { parse: never[] };
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
}

export function buildApplicationEmbed(app: NotificationApplication): DiscordWebhookPayload {
  const hardware = [
    `**CPU** ${safe(app.cpu, 200)}`,
    `**GPU** ${safe(app.gpu, 200)}`,
    `**RAM** ${safe(app.ram, 80)}`,
    `**OS** ${safe(app.operatingSystem, 150)}`,
  ].join("\n");

  const fields = [
    { name: "Application", value: `\`${app.publicApplicationId}\``, inline: true },
    { name: "Discord", value: safe(app.discordUsername, 100), inline: true },
    { name: "Applicant", value: safe(app.preferredName, 120), inline: true },
    { name: "Why they're interested", value: safe(app.interestReason, EMBED_LIMITS.fieldValue) },
    { name: "Relevant games", value: safe(app.similarGames, EMBED_LIMITS.fieldValue) },
    { name: "Experience", value: safe(app.testingExperience, EMBED_LIMITS.fieldValue) },
    { name: "Hardware", value: truncate(hardware, EMBED_LIMITS.fieldValue) },
    { name: "Backup email", value: app.email ? safe(app.email, 260) : "Not given", inline: true },
    { name: "Agreement", value: `Accepted — ${safe(app.agreementVersion, 80)}`, inline: true },
    { name: "Submitted", value: `${app.submittedAt.replace("T", " ").replace(/\.\d+Z$|Z$/, "")} UTC`, inline: true },
    { name: "Status", value: "**PENDING**", inline: true },
  ];
  if (app.additionalNotes) {
    fields.push({ name: "Additional notes", value: safe(app.additionalNotes, EMBED_LIMITS.fieldValue) });
  }

  const embed = {
    title: "PLAYTEST APPLICATION",
    description:
      `**${app.publicApplicationId}**\nFind it in Supabase → Table Editor → playtest_applications → public_application_id.`,
    color: EMBED_COLOR,
    fields,
    footer: { text: "Hexenbane Private Playtest · approval is manual" },
    timestamp: app.submittedAt,
  };

  // Keep the whole embed inside Discord's 6000-character budget by shortening the long answers.
  const size = () =>
    embed.title.length + embed.description.length + embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const longFields = ["Why they're interested", "Experience", "Relevant games", "Additional notes"];
  while (size() > EMBED_LIMITS.total) {
    const longest = embed.fields
      .filter((f) => longFields.includes(f.name))
      .sort((a, b) => b.value.length - a.value.length)[0];
    if (!longest || longest.value.length <= 200) break;
    longest.value = truncate(longest.value, longest.value.length - Math.max(100, size() - EMBED_LIMITS.total));
  }

  return {
    username: "Hexenbane Playtest",
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
}

const WEBHOOK_URL =
  /^https:\/\/(?:canary\.|ptb\.)?(?:discord\.com|discordapp\.com)\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK_URL.test(url);
}

export type NotifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Posts the payload to the webhook. Never throws and never logs the webhook URL:
 * a failed notification must not lose a stored application.
 */
export async function sendDiscordWebhook(
  webhookUrl: string | undefined,
  payload: DiscordWebhookPayload,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<NotifyResult> {
  if (!webhookUrl) return { ok: false, reason: "DISCORD_WEBHOOK_URL is not set" };
  if (!isDiscordWebhookUrl(webhookUrl)) {
    return { ok: false, reason: "DISCORD_WEBHOOK_URL is not a Discord webhook URL" };
  }
  try {
    const response = await fetchImpl(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      return { ok: false, reason: `Discord answered ${response.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? `${err.name}: ${err.message}` : "unknown error" };
  }
}
