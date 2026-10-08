// Posts into the #bug-reports forum channel through a webhook, with attachments.
//
// A webhook on a forum channel must send `thread_name` (the post's title) and may send
// `applied_tags` (forum tag ids). Files go as multipart/form-data: the JSON message in
// `payload_json` and each file as `files[n]`, described in the message's `attachments`.
//
// Player text is untrusted; the same two layers as the application notification apply:
// allowed_mentions: { parse: [] } on every message, and the text itself neutralised.

import { isDiscordWebhookUrl, neutralizeForDiscord, type NotifyResult, truncate } from "./discord.ts";
import type { ContextValue } from "./game-validation.ts";

export const THREAD_NAME_MAX = 100;
const ZERO_WIDTH_SPACE = "​";

/**
 * Makes text safe for a forum post title. Titles are shown literally (no markdown), so only
 * mention syntax is broken and the text is kept on one line; no backslash escapes.
 */
export function neutralizeThreadName(text: string, max = THREAD_NAME_MAX): string {
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/<(@[!&]?|#|\/|a?:)/g, `<${ZERO_WIDTH_SPACE}$1`)
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`)
    .trim();
  return truncate(clean || "Untitled report", max);
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface ForumEmbed {
  title: string;
  description: string;
  color: number;
  fields: EmbedField[];
  footer: { text: string };
  timestamp: string;
  image?: { url: string };
}

export interface ForumPostPayload {
  username: string;
  thread_name: string;
  applied_tags?: string[];
  allowed_mentions: { parse: never[] };
  embeds: ForumEmbed[];
  attachments?: Array<{ id: number; filename: string; description?: string }>;
}

export interface ForumFile {
  filename: string;
  contentType: string;
  data: Uint8Array | string;
}

/** Forum tag names J may map to ids in DISCORD_BUG_REPORTS_TAGS. */
export type ForumTagName = "New" | "Crash" | "UI" | "Combat";

/**
 * Parses DISCORD_BUG_REPORTS_TAGS, e.g. {"New":"123…","Crash":"456…"}. Anything that is not a
 * name→snowflake pair is ignored, so a mistake there never blocks a report.
 */
export function parseForumTags(value: string | undefined | null): Partial<Record<string, string>> {
  if (!value || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, id] of Object.entries(parsed as Record<string, unknown>)) {
      const text = typeof id === "number" ? String(id) : id;
      if (typeof text === "string" && /^\d{5,25}$/.test(text)) out[name] = text;
    }
    return out;
  } catch {
    return {};
  }
}

/** The ids for "New" plus the given tag names that are configured, without repeats (max 5). */
export function pickTags(tags: Partial<Record<string, string>>, names: readonly string[]): string[] {
  const ids: string[] = [];
  for (const name of ["New", ...names]) {
    const id = tags[name];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 5);
}

/**
 * Builds the multipart body for a forum post. Each file becomes `files[n]` and is listed in the
 * payload's `attachments` with the same id, so embeds can show it as attachment://<filename>.
 */
export function buildForumMultipart(payload: ForumPostPayload, files: readonly ForumFile[]): FormData {
  const message: ForumPostPayload = {
    ...payload,
    attachments: files.map((f, id) => ({ id, filename: f.filename })),
  };
  const form = new FormData();
  form.append("payload_json", JSON.stringify(message));
  files.forEach((file, i) => {
    const part = typeof file.data === "string" ? file.data : new Uint8Array(file.data);
    form.append(`files[${i}]`, new Blob([part], { type: file.contentType }), file.filename);
  });
  return form;
}

/**
 * Creates the forum post. Never throws and never logs the webhook URL: the caller decides what
 * a failed post means (feedback reports it to the player; crashes are stored regardless).
 */
export async function sendDiscordForumPost(
  webhookUrl: string | undefined,
  payload: ForumPostPayload,
  files: readonly ForumFile[] = [],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<NotifyResult> {
  if (!webhookUrl) return { ok: false, reason: "DISCORD_BUG_REPORTS_WEBHOOK_URL is not set" };
  if (!isDiscordWebhookUrl(webhookUrl)) {
    return { ok: false, reason: "DISCORD_BUG_REPORTS_WEBHOOK_URL is not a Discord webhook URL" };
  }
  try {
    const response = await fetchImpl(`${webhookUrl}?wait=true`, {
      method: "POST",
      body: buildForumMultipart(payload, files),
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

/** Sum of the embed's text, as Discord counts it towards its 6000-character limit. */
export function embedSize(embed: ForumEmbed): number {
  return embed.title.length + embed.description.length + embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

const show = (value: ContextValue | undefined): string | null => {
  if (value === undefined || value === "") return null;
  const text = Array.isArray(value) ? value.join(" + ") : String(value);
  return text.trim() ? neutralizeForDiscord(text.trim()) : null;
};

/** "Scene · Coven · Night 3 · Hour 2 · Quarry" from a report's context, neutralised. */
export function formatWhere(context: Record<string, ContextValue>): string {
  const parts = [
    show(context.scene),
    show(context.coven) && `Coven ${show(context.coven)}`,
    show(context.implements) && `Implements ${show(context.implements)}`,
    show(context.night) && `Night ${show(context.night)}`,
    show(context.hours) && `Hour ${show(context.hours)}`,
    show(context.vitality) && `Vitality ${show(context.vitality)}`,
    show(context.quarry) && `Quarry ${show(context.quarry)}`,
  ].filter(Boolean);
  return truncate(parts.join(" · ") || "—", 1024);
}

/** "OS · GPU · window" from a report's context, neutralised. */
export function formatPc(context: Record<string, ContextValue>): string {
  const parts = [show(context.os), show(context.gpu), show(context.window)].filter(Boolean);
  return truncate(parts.join(" · ") || "—", 1024);
}

/** Embed text: neutralised, trimmed, cut to `max`, with a fallback when empty. */
export function safeText(text: string | null | undefined, max: number, fallback = "—"): string {
  const value = text && text.trim() ? neutralizeForDiscord(text.trim()) : fallback;
  return truncate(value, max) || fallback;
}

/** Shortens the description until the whole embed is inside Discord's 6000-character budget. */
export function fitEmbed(embed: ForumEmbed, budget = 6000): ForumEmbed {
  const over = embedSize(embed) - budget;
  if (over > 0) embed.description = truncate(embed.description, Math.max(1, embed.description.length - over - 1));
  return embed;
}
