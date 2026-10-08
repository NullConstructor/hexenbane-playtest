import { describe, expect, it } from "vitest";
import { crashSignature, firstStackLine, validateCrash } from "../supabase/functions/_shared/crash.ts";
import { decodeJpeg, validateFeedback } from "../supabase/functions/_shared/feedback.ts";
import {
  cleanText,
  isGameVersion,
  isUuidV4,
  parseUtcTimestamp,
} from "../supabase/functions/_shared/game-validation.ts";
import { generateReportId, REPORT_ID_PATTERN } from "../supabase/functions/_shared/ids.ts";
import { TELEMETRY_LIMITS, validateTelemetry } from "../supabase/functions/_shared/telemetry.ts";
import { crashBody, feedbackBody, INSTALL_ID, jpegBase64, telemetryBody } from "./fixtures.ts";

describe("shared game validation", () => {
  it("accepts semver-ish versions up to 32 characters", () => {
    for (const v of ["0.8.0", "v0.8.0", "1.2", "0.8.1-playtest", "0.8.1+build.7"]) expect(isGameVersion(v)).toBe(true);
    for (const v of ["", "eight", "0.8.0 ", "0.8.0;drop", "1.2.3-" + "x".repeat(30), 8, null]) {
      expect(isGameVersion(v)).toBe(false);
    }
  });

  it("checks UUID v4 install ids", () => {
    expect(isUuidV4(INSTALL_ID)).toBe(true);
    expect(isUuidV4(INSTALL_ID.toUpperCase())).toBe(true);
    expect(isUuidV4("7c9e6679-7425-10de-944b-e07fc1f90ae7")).toBe(false); // v1
    expect(isUuidV4("not-a-uuid")).toBe(false);
  });

  it("reads UTC timestamps, including Godot's bare form, and refuses impossible dates", () => {
    expect(parseUtcTimestamp("2026-10-08T12:00:00Z")).toBe("2026-10-08T12:00:00.000Z");
    expect(parseUtcTimestamp("2026-10-08T12:00:00.5Z")).toBe("2026-10-08T12:00:00.500Z");
    expect(parseUtcTimestamp("2026-10-08T12:00:00")).toBe("2026-10-08T12:00:00.000Z");
    expect(parseUtcTimestamp("2026-10-08T12:00:00+00:00")).toBe("2026-10-08T12:00:00.000Z");
    for (const bad of ["2026-02-31T00:00:00Z", "2026-10-08T25:00:00Z", "2026-10-08T12:00:00+02:00", "yesterday", 1, ""]) {
      expect(parseUtcTimestamp(bad)).toBeNull();
    }
  });

  it("strips NUL, control characters and colour codes but keeps newlines", () => {
    expect(cleanText("a\u0000b\u001b[31mred\u001b[0m\r\nc\td", false)).toBe("abred\nc\td");
    expect(cleanText("  one\n two  ", true)).toBe("one two");
  });

  it("makes BR-/CR- report ids", () => {
    expect(generateReportId("BR")).toMatch(REPORT_ID_PATTERN);
    expect(generateReportId("CR")).toMatch(/^CR-/);
  });
});

describe("validateTelemetry", () => {
  it("accepts a batch and returns one row per event", () => {
    const result = validateTelemetry(telemetryBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installId).toBe(INSTALL_ID);
      expect(result.value.rows).toHaveLength(2);
      expect(result.value.rows[1]).toMatchObject({ name: "fight_end", seq: 1, occurred_at: "2026-10-08T12:05:00.250Z" });
    }
  });

  it("refuses bad ids, unknown events, negative seq, bad times and non-object data", () => {
    const bad = (overrides: Record<string, unknown>) => validateTelemetry(telemetryBody(overrides));
    expect(bad({ install_id: "x" }).ok).toBe(false);
    expect(bad({ session_id: 7 }).ok).toBe(false);
    expect(bad({ version: "latest" }).ok).toBe(false);
    for (const event of [
      { name: "drop_table", seq: 0, at: "2026-10-08T12:00:00Z", data: {} },
      { name: "hunt_end", seq: -1, at: "2026-10-08T12:00:00Z", data: {} },
      { name: "hunt_end", seq: 1.5, at: "2026-10-08T12:00:00Z", data: {} },
      { name: "hunt_end", seq: 1, at: "soon", data: {} },
      { name: "hunt_end", seq: 1, at: "2026-10-08T12:00:00Z", data: [1, 2] },
      { name: "hunt_end", seq: 1, at: "2026-10-08T12:00:00Z", data: { s: "nul\u0000" } },
    ]) {
      expect(bad({ events: [event] }).ok).toBe(false);
    }
  });

  it("limits a batch to 1..200 events and each event's data to 8 KB", () => {
    const event = (seq: number) => ({ name: "purchase", seq, at: "2026-10-08T12:00:00Z", data: {} });
    expect(validateTelemetry(telemetryBody({ events: [] })).ok).toBe(false);
    expect(validateTelemetry(telemetryBody({ events: Array.from({ length: 200 }, (_, i) => event(i)) })).ok).toBe(true);
    expect(validateTelemetry(telemetryBody({ events: Array.from({ length: 201 }, (_, i) => event(i)) })).ok).toBe(false);
    const big = { ...event(0), data: { blob: "x".repeat(TELEMETRY_LIMITS.maxDataBytes) } };
    expect(validateTelemetry(telemetryBody({ events: [big] })).ok).toBe(false);
  });
});

describe("validateCrash and crash signatures", () => {
  it("accepts a crash report and drops unknown context keys", () => {
    const result = validateCrash(crashBody({ context: { ...crashBody().context, secret_path: "C:/Users/x" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.context).not.toHaveProperty("secret_path");
      expect(result.value.context.night).toBe(2);
    }
  });

  it("refuses wrong kinds, long messages, oversized logs and missing context", () => {
    expect(validateCrash(crashBody({ kind: "panic" })).ok).toBe(false);
    expect(validateCrash(crashBody({ message: "" })).ok).toBe(false);
    expect(validateCrash(crashBody({ message: "m".repeat(2001) })).ok).toBe(false);
    expect(validateCrash(crashBody({ stack: "s".repeat(8001) })).ok).toBe(false);
    expect(validateCrash(crashBody({ log_tail: "l".repeat(64 * 1024 + 1) })).ok).toBe(false);
    expect(validateCrash(crashBody({ context: { os: "Windows" } })).ok).toBe(false);
    expect(validateCrash(crashBody({ occurred_at: "now" })).ok).toBe(false);
  });

  it("allows an empty stack and log", () => {
    expect(validateCrash(crashBody({ stack: "", log_tail: "" })).ok).toBe(true);
  });

  it("groups the same crash regardless of digits in the message", async () => {
    const a = await crashSignature({ version: "0.8.0", kind: "crash", message: "at 0x7ff612345678 id 42", stack: "res://a.gd:1\nmore" });
    const b = await crashSignature({ version: "0.8.0", kind: "crash", message: "at 0x7ff699999999 id 7", stack: "  res://a.gd:1  \nother" });
    const otherVersion = await crashSignature({ version: "0.8.1", kind: "crash", message: "at 0x7ff612345678 id 42", stack: "res://a.gd:1" });
    const otherLine = await crashSignature({ version: "0.8.0", kind: "crash", message: "at 0x7ff612345678 id 42", stack: "res://a.gd:2" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(otherVersion);
    expect(a).not.toBe(otherLine);
    expect(firstStackLine("\n\n  first \nsecond")).toBe("first");
  });
});

describe("validateFeedback", () => {
  it("accepts a report with a JPEG screenshot and a log", () => {
    const result = validateFeedback(feedbackBody({ screenshot_jpg: jpegBase64(), log: "log text" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.screenshot?.[0]).toBe(0xff);
      expect(result.value.context.implements).toEqual(["censer", "nails"]);
    }
  });

  it("checks kind, title length, details length and the context", () => {
    expect(validateFeedback(feedbackBody({ kind: "Rant" })).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ title: "   " })).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ title: "t".repeat(91) })).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ details: "d".repeat(4001) })).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ context: { scene: "Fight" } })).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ context: { ...feedbackBody().context, night: "two" } })).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ log: "l".repeat(64 * 1024 + 1) })).ok).toBe(false);
  });

  it("only accepts real JPEGs up to 3 MB", () => {
    expect(decodeJpeg(jpegBase64()).ok).toBe(true);
    expect(decodeJpeg(Buffer.from("\x89PNG\r\n\x1a\n").toString("base64")).ok).toBe(false);
    expect(decodeJpeg("not base64!").ok).toBe(false);
    expect(decodeJpeg(jpegBase64(3 * 1024 * 1024)).ok).toBe(true);
    expect(decodeJpeg(jpegBase64(3 * 1024 * 1024 + 3)).ok).toBe(false);
    expect(validateFeedback(feedbackBody({ screenshot_jpg: "AAAA" })).ok).toBe(false);
  });
});
