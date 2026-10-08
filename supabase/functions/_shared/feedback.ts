// submit-feedback: the in-game F8 report form. Each report becomes a post in the #bug-reports
// forum (with the screenshot and the game log attached) and a row in feedback_reports.
//
// The game tells the player whether their report arrived, so the answer reflects Discord:
// 200 { ok: true, id } when the post was created, 502 { ok: false, error: "discord_failed", id }
// when it was not. Either way the row is kept (discord_ok says which). The screenshot and log
// are only forwarded to Discord, never stored in the database.

import {
  fitEmbed,
  type ForumFile,
  type ForumPostPayload,
  formatPc,
  formatWhere,
  neutralizeThreadName,
  pickTags,
  safeText,
} from "./discord-forum.ts";
import type { ForumNotifier, ReportInsertResult } from "./crash.ts";
import { createGameEndpoint, type GameDeps, type GameEndpointConfig, type Validated } from "./game-http.ts";
import {
  type ContextSpec,
  type ContextValue,
  type FieldErrors,
  isGameVersion,
  isPlainObject,
  isUuidV4,
  readContext,
  readText,
} from "./game-validation.ts";
import { generateReportId } from "./ids.ts";

export const FEEDBACK_KINDS = ["Bug", "Crash", "Balance", "UI", "Other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_LIMITS = {
  title: 90,
  details: 4000,
  screenshotBytes: 3 * 1024 * 1024,
  logBytes: 64 * 1024,
  // A 3 MB screenshot is 4 MB of base64, plus the log (escaping can grow it) and the text.
  maxBodyBytes: 5 * 1024 * 1024,
} as const;

export const FEEDBACK_ENDPOINT: GameEndpointConfig = {
  name: "submit-feedback",
  maxBodyBytes: FEEDBACK_LIMITS.maxBodyBytes,
  installRule: { bucket: "feedback:install", limit: 10, windowSeconds: 3600 },
  ipRule: { bucket: "feedback:ip", limit: 30, windowSeconds: 3600 },
};

export const FEEDBACK_CONTEXT: ContextSpec = {
  required: ["version", "scene", "os", "gpu", "window", "time_utc"],
  text: ["version", "scene", "os", "gpu", "window", "time_utc", "coven", "quarry"],
  numbers: ["night", "hours", "vitality"],
  lists: ["implements"],
};

/** Extra forum tag (besides "New") per report kind, when that tag is configured. */
export const KIND_TAGS: Record<FeedbackKind, string[]> = {
  Bug: [],
  Crash: ["Crash"],
  Balance: ["Combat"],
  UI: ["UI"],
  Other: [],
};

export interface FeedbackReport {
  install_id: string;
  version: string;
  kind: FeedbackKind;
  title: string;
  details: string;
  context: Record<string, ContextValue>;
  screenshot: Uint8Array | null;
  log: string;
}

export interface FeedbackRow {
  report_id: string;
  install_id: string;
  version: string;
  kind: FeedbackKind;
  title: string;
  details: string;
  context: Record<string, ContextValue>;
  has_screenshot: boolean;
  has_log: boolean;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes a base64 JPEG, checking the size and the JPEG magic bytes. */
export function decodeJpeg(
  value: unknown,
  maxBytes: number = FEEDBACK_LIMITS.screenshotBytes,
): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "must be a base64 string" };
  if (value.length > Math.ceil(maxBytes / 3) * 4) return { ok: false, error: `must be at most ${maxBytes} bytes` };
  if (value.length % 4 !== 0 || !BASE64.test(value)) return { ok: false, error: "must be valid base64" };
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return { ok: false, error: "must be valid base64" };
  }
  if (binary.length > maxBytes) return { ok: false, error: `must be at most ${maxBytes} bytes` };
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, error: "must be a JPEG image" };
  }
  return { ok: true, bytes };
}

export function validateFeedback(input: unknown): Validated<FeedbackReport> {
  const errors: FieldErrors = {};
  if (!isPlainObject(input)) return { ok: false, errors: { body: "must be a JSON object" } };

  if (!isUuidV4(input.install_id)) errors.install_id = "must be a UUID v4";
  if (!isGameVersion(input.version)) errors.version = "must be a game version";
  if (!(FEEDBACK_KINDS as readonly unknown[]).includes(input.kind)) {
    errors.kind = `must be one of ${FEEDBACK_KINDS.join(", ")}`;
  }
  const title = readText(input, "title", errors, { min: 1, max: FEEDBACK_LIMITS.title, singleLine: true });
  const details = readText(input, "details", errors, { max: FEEDBACK_LIMITS.details, optional: true });
  const context = readContext(input, "context", FEEDBACK_CONTEXT, errors);
  const log = readText(input, "log", errors, {
    max: FEEDBACK_LIMITS.logBytes,
    maxBytes: FEEDBACK_LIMITS.logBytes,
    optional: true,
  });

  let screenshot: Uint8Array | null = null;
  if (input.screenshot_jpg !== undefined && input.screenshot_jpg !== null && input.screenshot_jpg !== "") {
    const decoded = decodeJpeg(input.screenshot_jpg);
    if (decoded.ok) screenshot = decoded.bytes;
    else errors.screenshot_jpg = decoded.error;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  const installId = (input.install_id as string).toLowerCase();
  return {
    ok: true,
    installId,
    value: {
      install_id: installId,
      version: input.version as string,
      kind: input.kind as FeedbackKind,
      title: title!,
      details: details!.trim(),
      context: context!,
      screenshot,
      log: log!,
    },
  };
}

const FEEDBACK_COLOR = 0x5b3f99; // Hexenbane violet

export function buildFeedbackPost(
  report: FeedbackReport,
  meta: { reportId: string; tags: Partial<Record<string, string>>; at: string },
): { payload: ForumPostPayload; files: ForumFile[] } {
  const files: ForumFile[] = [];
  if (report.screenshot) files.push({ filename: "screenshot.jpg", contentType: "image/jpeg", data: report.screenshot });
  if (report.log.trim()) files.push({ filename: "game-log.txt", contentType: "text/plain; charset=utf-8", data: report.log });

  const embed = fitEmbed({
    title: safeText(report.title, 256),
    description: safeText(report.details, 4096, "No details given."),
    color: FEEDBACK_COLOR,
    fields: [
      { name: "Kind", value: report.kind, inline: true },
      { name: "Version", value: safeText(report.version, 64), inline: true },
      { name: "Where", value: formatWhere(report.context) },
      { name: "PC", value: formatPc(report.context) },
    ],
    footer: { text: `Report ${meta.reportId} · install ${report.install_id.slice(0, 8)}` },
    timestamp: meta.at,
    ...(report.screenshot ? { image: { url: "attachment://screenshot.jpg" } } : {}),
  });

  const payload: ForumPostPayload = {
    username: "Hexenbane Bug Reports",
    thread_name: neutralizeThreadName(report.title),
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
  const tags = pickTags(meta.tags, KIND_TAGS[report.kind]);
  if (tags.length) payload.applied_tags = tags;
  return { payload, files };
}

export interface FeedbackStore {
  insertFeedback(row: FeedbackRow): Promise<ReportInsertResult>;
  /** Records that the forum post was created (discord_ok = true). */
  markDiscordPosted(reportId: string, at: string): Promise<void>;
}

export interface FeedbackDeps extends GameDeps {
  store: FeedbackStore;
  /** Null when DISCORD_BUG_REPORTS_WEBHOOK_URL is not set: every report answers 502. */
  notify: ForumNotifier | null;
  tags?: Partial<Record<string, string>>;
  newReportId?: () => string;
}

const MAX_ID_ATTEMPTS = 5;

export function createFeedbackHandler(deps: FeedbackDeps): (request: Request) => Promise<Response> {
  const newId = deps.newReportId ?? (() => generateReportId("BR"));
  return createGameEndpoint(FEEDBACK_ENDPOINT, deps, validateFeedback, async (report, ctx) => {
    let reportId = "";
    let inserted: ReportInsertResult = "duplicate_id";
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && inserted === "duplicate_id"; attempt++) {
      reportId = newId();
      inserted = await deps.store.insertFeedback({
        report_id: reportId,
        install_id: report.install_id,
        version: report.version,
        kind: report.kind,
        title: report.title,
        details: report.details,
        context: report.context,
        has_screenshot: report.screenshot !== null,
        has_log: report.log.trim() !== "",
      });
    }
    if (inserted !== "ok") throw new Error(`could not generate a unique report ID in ${MAX_ID_ATTEMPTS} attempts`);
    ctx.log.info("feedback stored", { reportId, kind: report.kind, version: report.version });

    let posted = false;
    try {
      if (deps.notify) {
        const { payload, files } = buildFeedbackPost(report, {
          reportId,
          tags: deps.tags ?? {},
          at: ctx.now.toISOString(),
        });
        const result = await deps.notify(payload, files);
        posted = result.ok;
        if (!result.ok) ctx.log.error("feedback forum post failed; report is stored", { reportId, reason: result.reason });
      } else {
        ctx.log.error("DISCORD_BUG_REPORTS_WEBHOOK_URL is not set; feedback stored only", { reportId });
      }
    } catch (err) {
      ctx.log.error("feedback notification step threw; report is stored", { reportId, error: String(err) });
    }

    try {
      if (posted) await deps.store.markDiscordPosted(reportId, ctx.now.toISOString());
    } catch (err) {
      ctx.log.error("could not record discord_ok", { reportId, error: String(err) });
    }

    if (posted) return { status: 200, body: { ok: true, id: reportId } };
    return {
      status: 502,
      body: {
        ok: false,
        error: "discord_failed",
        message: "Your report was saved, but it could not be posted to Discord.",
        id: reportId,
      },
    };
  });
}
