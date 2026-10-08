// submit-crash: crash and script-error reports from the game, stored in crash_reports.
//
// Every report is stored. Discord hears about a crash only the first time its signature is
// seen (the signature already includes the version), so one common crash makes one forum post,
// not hundreds; repeats are counted in the crash_summary view.

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
import { type NotifyResult, truncate } from "./discord.ts";
import { createGameEndpoint, type GameDeps, type GameEndpointConfig, type Validated } from "./game-http.ts";
import {
  type ContextSpec,
  type ContextValue,
  type FieldErrors,
  isGameVersion,
  isPlainObject,
  isUuid,
  isUuidV4,
  parseUtcTimestamp,
  readContext,
  readText,
  sha256Hex,
} from "./game-validation.ts";
import { generateReportId } from "./ids.ts";

export const CRASH_LIMITS = {
  // The log tail alone may be 64 KB, and JSON escaping can grow it; leave generous room.
  maxBodyBytes: 384 * 1024,
  message: 2000,
  stack: 8000,
  logTailBytes: 64 * 1024,
} as const;

export const CRASH_ENDPOINT: GameEndpointConfig = {
  name: "submit-crash",
  maxBodyBytes: CRASH_LIMITS.maxBodyBytes,
  installRule: { bucket: "crash:install", limit: 20, windowSeconds: 3600 },
  ipRule: { bucket: "crash:ip", limit: 60, windowSeconds: 3600 },
};

export const CRASH_CONTEXT: ContextSpec = {
  required: ["os", "gpu", "window", "scene"],
  text: ["os", "gpu", "window", "scene", "coven", "quarry"],
  numbers: ["night", "hours"],
};

export type CrashKind = "crash" | "error";

export interface CrashReport {
  install_id: string;
  session_id: string;
  version: string;
  kind: CrashKind;
  message: string;
  stack: string;
  log_tail: string;
  occurred_at: string;
  context: Record<string, ContextValue>;
}

export interface CrashRow extends CrashReport {
  report_id: string;
  signature: string;
}

export function validateCrash(input: unknown): Validated<CrashReport> {
  const errors: FieldErrors = {};
  if (!isPlainObject(input)) return { ok: false, errors: { body: "must be a JSON object" } };

  if (!isUuidV4(input.install_id)) errors.install_id = "must be a UUID v4";
  if (!isUuid(input.session_id)) errors.session_id = "must be a UUID";
  if (!isGameVersion(input.version)) errors.version = "must be a game version";
  if (input.kind !== "crash" && input.kind !== "error") errors.kind = 'must be "crash" or "error"';
  const message = readText(input, "message", errors, { min: 1, max: CRASH_LIMITS.message });
  const stack = readText(input, "stack", errors, { max: CRASH_LIMITS.stack, optional: true });
  const logTail = readText(input, "log_tail", errors, {
    max: CRASH_LIMITS.logTailBytes,
    maxBytes: CRASH_LIMITS.logTailBytes,
    optional: true,
  });
  const occurredAt = parseUtcTimestamp(input.occurred_at);
  if (!occurredAt) errors.occurred_at = "must be an ISO-8601 UTC timestamp";
  const context = readContext(input, "context", CRASH_CONTEXT, errors);

  if (Object.keys(errors).length) return { ok: false, errors };
  const installId = (input.install_id as string).toLowerCase();
  return {
    ok: true,
    installId,
    value: {
      install_id: installId,
      session_id: (input.session_id as string).toLowerCase(),
      version: input.version as string,
      kind: input.kind as CrashKind,
      message: message!.trim(),
      stack: stack!.trim(),
      log_tail: logTail!,
      occurred_at: occurredAt!,
      context: context!,
    },
  };
}

/** The first non-empty line of a stack trace, trimmed. */
export function firstStackLine(stack: string): string {
  return stack.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * Groups reports of the same crash: SHA-256 of version, kind, the message with its digits
 * removed (so addresses, ids and counts don't split a group) and the first stack line.
 */
export function crashSignature(report: Pick<CrashReport, "version" | "kind" | "message" | "stack">): Promise<string> {
  const message = report.message.replace(/\d+/g, "");
  return sha256Hex([report.version, report.kind, message, firstStackLine(report.stack)].join("\n"));
}

const CRASH_COLOR = 0xb3261e;

export function buildCrashPost(
  report: CrashReport,
  meta: { reportId: string; signature: string; tags: Partial<Record<string, string>>; at: string },
): { payload: ForumPostPayload; files: ForumFile[] } {
  const stackLines = report.stack.split("\n").slice(0, 12).join("\n");
  const description = [
    safeText(report.message, 1800),
    stackLines.trim() ? `\n**Stack**\n${safeText(stackLines, 2000)}` : "",
  ].join("\n");
  const payload: ForumPostPayload = {
    username: "Hexenbane Crash Reports",
    thread_name: neutralizeThreadName(`[Crash] ${report.message}`),
    allowed_mentions: { parse: [] },
    embeds: [fitEmbed({
      title: report.kind === "crash" ? "CRASH" : "SCRIPT ERROR",
      description: truncate(description, 4096),
      color: CRASH_COLOR,
      fields: [
        { name: "Version", value: safeText(report.version, 64), inline: true },
        { name: "Kind", value: report.kind, inline: true },
        { name: "When", value: `${report.occurred_at.replace("T", " ").replace(/\.\d+Z$|Z$/, "")} UTC`, inline: true },
        { name: "Where", value: formatWhere(report.context) },
        { name: "PC", value: formatPc(report.context) },
        {
          name: "Count",
          value:
            `First report of this crash in ${safeText(report.version, 64)}. Repeats are counted, not posted: see the crash_summary view, signature \`${
              meta.signature.slice(0, 12)
            }\`.`,
        },
      ],
      footer: { text: `Report ${meta.reportId} · install ${report.install_id.slice(0, 8)}` },
      timestamp: meta.at,
    })],
  };
  const tags = pickTags(meta.tags, ["Crash"]);
  if (tags.length) payload.applied_tags = tags;
  const files: ForumFile[] = report.log_tail.trim()
    ? [{ filename: "crash-log.txt", contentType: "text/plain; charset=utf-8", data: report.log_tail }]
    : [];
  return { payload, files };
}

export type ReportInsertResult = "ok" | "duplicate_id";

export interface CrashStore {
  insertCrash(row: CrashRow): Promise<ReportInsertResult>;
  /**
   * Counts this signature and says whether this request should post it to Discord: true only
   * while it has never been posted and no other request is posting it right now. With
   * `claim` false (no webhook configured) it only counts.
   */
  recordSignature(signature: string, version: string, claim: boolean): Promise<{ seen: number; notify: boolean }>;
  markSignaturePosted(signature: string): Promise<void>;
}

export type ForumNotifier = (payload: ForumPostPayload, files: ForumFile[]) => Promise<NotifyResult>;

export interface CrashDeps extends GameDeps {
  store: CrashStore;
  /** Null when DISCORD_BUG_REPORTS_WEBHOOK_URL is not set: reports are only stored. */
  notify: ForumNotifier | null;
  tags?: Partial<Record<string, string>>;
  newReportId?: () => string;
}

const MAX_ID_ATTEMPTS = 5;

export function createCrashHandler(deps: CrashDeps): (request: Request) => Promise<Response> {
  const newId = deps.newReportId ?? (() => generateReportId("CR"));
  return createGameEndpoint(CRASH_ENDPOINT, deps, validateCrash, async (report, ctx) => {
    const signature = await crashSignature(report);
    let reportId = "";
    let inserted: ReportInsertResult = "duplicate_id";
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && inserted === "duplicate_id"; attempt++) {
      reportId = newId();
      inserted = await deps.store.insertCrash({ ...report, report_id: reportId, signature });
    }
    if (inserted !== "ok") throw new Error(`could not generate a unique report ID in ${MAX_ID_ATTEMPTS} attempts`);
    ctx.log.info("crash stored", { reportId, signature: signature.slice(0, 12), version: report.version });

    // Stored; from here on nothing turns this into a failure for the game.
    let posted = false;
    try {
      const { seen, notify } = await deps.store.recordSignature(signature, report.version, deps.notify !== null);
      if (notify && deps.notify) {
        const { payload, files } = buildCrashPost(report, {
          reportId,
          signature,
          tags: deps.tags ?? {},
          at: ctx.now.toISOString(),
        });
        const result = await deps.notify(payload, files);
        if (result.ok) {
          posted = true;
          await deps.store.markSignaturePosted(signature);
        } else {
          ctx.log.error("crash forum post failed; report is stored", { reportId, reason: result.reason });
        }
      } else {
        ctx.log.info("crash signature already reported", { reportId, seen });
      }
    } catch (err) {
      ctx.log.error("crash notification step threw; report is stored", { reportId, error: String(err) });
    }
    return { status: 200, body: { ok: true, id: reportId, posted } };
  });
}
