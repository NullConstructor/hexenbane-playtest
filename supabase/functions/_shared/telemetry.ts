// ingest-telemetry: batches of gameplay events from the game, stored in telemetry_events.
//
// A batch is all-or-nothing: one bad event refuses the whole batch with 400, so the game should
// drop a batch on any 4xx except 429, and retry on 429 or 5xx. Retrying is safe: (session_id,
// seq) is unique and duplicates are skipped, so a batch is never counted twice.

import {
  createGameEndpoint,
  type GameDeps,
  type GameEndpointConfig,
  type GameResult,
  type Validated,
} from "./game-http.ts";
import {
  type FieldErrors,
  isGameVersion,
  isPlainObject,
  isUuid,
  isUuidV4,
  parseUtcTimestamp,
  utf8Bytes,
} from "./game-validation.ts";

export const TELEMETRY_EVENT_NAMES = [
  "session_start",
  "session_end",
  "hunt_start",
  "fight_end",
  "card_offer",
  "boss_reward",
  "purchase",
  "inscription_cut",
  "scene_lead",
  "hunt_end",
  "feedback_sent",
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export const TELEMETRY_LIMITS = {
  maxBodyBytes: 512 * 1024,
  minEvents: 1,
  maxEvents: 200,
  maxDataBytes: 8 * 1024,
  maxSeq: 2_147_483_647, // Postgres integer
} as const;

export const TELEMETRY_ENDPOINT: GameEndpointConfig = {
  name: "ingest-telemetry",
  maxBodyBytes: TELEMETRY_LIMITS.maxBodyBytes,
  installRule: { bucket: "telemetry:install", limit: 60, windowSeconds: 600 },
  ipRule: { bucket: "telemetry:ip", limit: 300, windowSeconds: 600 },
};

export interface TelemetryRow {
  install_id: string;
  session_id: string;
  version: string;
  name: TelemetryEventName;
  seq: number;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface TelemetryBatch {
  rows: TelemetryRow[];
}

const NAMES: ReadonlySet<string> = new Set(TELEMETRY_EVENT_NAMES);

/** Validates a batch and returns the rows to insert, or field errors (at most 20 listed). */
export function validateTelemetry(input: unknown): Validated<TelemetryBatch> {
  const errors: FieldErrors = {};
  if (!isPlainObject(input)) return { ok: false, errors: { body: "must be a JSON object" } };

  const installId = input.install_id;
  const sessionId = input.session_id;
  const version = input.version;
  if (!isUuidV4(installId)) errors.install_id = "must be a UUID v4";
  if (!isUuid(sessionId)) errors.session_id = "must be a UUID";
  if (!isGameVersion(version)) errors.version = "must be a game version";

  const events = input.events;
  if (!Array.isArray(events)) {
    errors.events = "must be an array";
  } else if (events.length < TELEMETRY_LIMITS.minEvents || events.length > TELEMETRY_LIMITS.maxEvents) {
    errors.events = `must hold ${TELEMETRY_LIMITS.minEvents} to ${TELEMETRY_LIMITS.maxEvents} events`;
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const rows: TelemetryRow[] = [];
  for (const [i, event] of (events as unknown[]).entries()) {
    if (Object.keys(errors).length >= 20) break;
    const at = `events[${i}]`;
    if (!isPlainObject(event)) {
      errors[at] = "must be an object";
      continue;
    }
    const { name, seq, data } = event;
    if (typeof name !== "string" || !NAMES.has(name)) {
      errors[`${at}.name`] = "is not a known event";
      continue;
    }
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > TELEMETRY_LIMITS.maxSeq) {
      errors[`${at}.seq`] = "must be a whole number >= 0";
      continue;
    }
    const occurredAt = parseUtcTimestamp(event.at);
    if (!occurredAt) {
      errors[`${at}.at`] = "must be an ISO-8601 UTC timestamp";
      continue;
    }
    if (!isPlainObject(data)) {
      errors[`${at}.data`] = "must be an object";
      continue;
    }
    const serialised = JSON.stringify(data);
    if (utf8Bytes(serialised) > TELEMETRY_LIMITS.maxDataBytes) {
      errors[`${at}.data`] = `must be at most ${TELEMETRY_LIMITS.maxDataBytes} bytes as JSON`;
      continue;
    }
    // Postgres jsonb cannot hold a NUL character.
    if (serialised.includes("\\u0000")) {
      errors[`${at}.data`] = "must not contain NUL characters";
      continue;
    }
    rows.push({
      install_id: (installId as string).toLowerCase(),
      session_id: (sessionId as string).toLowerCase(),
      version: version as string,
      name: name as TelemetryEventName,
      seq,
      occurred_at: occurredAt,
      data,
    });
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { rows }, installId: (installId as string).toLowerCase() };
}

export interface TelemetryStore {
  /** Inserts the rows, skipping any (session_id, seq) already stored. Returns how many were new. */
  insertEvents(rows: TelemetryRow[]): Promise<number>;
}

export function createTelemetryHandler(
  deps: GameDeps & { store: TelemetryStore },
): (request: Request) => Promise<Response> {
  return createGameEndpoint(TELEMETRY_ENDPOINT, deps, validateTelemetry, async (batch, ctx): Promise<GameResult> => {
    const inserted = await deps.store.insertEvents(batch.rows);
    ctx.log.info("telemetry stored", { events: batch.rows.length, inserted, build: ctx.build });
    return {
      status: 200,
      body: { ok: true, accepted: batch.rows.length, duplicates: batch.rows.length - inserted },
    };
  });
}
