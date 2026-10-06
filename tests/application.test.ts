import { describe, expect, it } from "vitest";
import {
  checkSpamSignals,
  FIELD_LIMITS,
  MIN_FILL_MS,
  normalizeDiscordUsername,
  sanitizeText,
  validateApplication,
} from "../supabase/functions/_shared/application.ts";
import { validInput } from "./fixtures.ts";

describe("validateApplication", () => {
  it("accepts a complete application and nulls empty optional fields", () => {
    const result = validateApplication(validInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBeNull();
      expect(result.value.additionalNotes).toBeNull();
    }
  });

  it("requires every required field", () => {
    const result = validateApplication({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const f of ["preferredName", "discordUsername", "interestReason", "similarGames", "testingExperience", "cpu", "gpu", "ram", "operatingSystem", "joinedDiscord", "agreementAccepted"]) {
        expect(result.errors).toHaveProperty(f);
      }
      expect(result.errors).not.toHaveProperty("email");
      expect(result.errors).not.toHaveProperty("additionalNotes");
    }
  });

  it("refuses submission without agreeing or joining Discord, even as truthy non-booleans", () => {
    for (const bad of [false, "true", 1, null, undefined]) {
      const result = validateApplication({ ...validInput(), agreementAccepted: bad, joinedDiscord: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.agreementAccepted).toBeTruthy();
        expect(result.errors.joinedDiscord).toBeTruthy();
      }
    }
  });

  it("enforces maximum lengths", () => {
    for (const [field, { max }] of Object.entries(FIELD_LIMITS)) {
      const value = field === "email" ? `${"a".repeat(max)}@x.io` : field === "discordUsername" ? "a".repeat(max + 1) : "x".repeat(max + 1);
      const result = validateApplication({ ...validInput(), [field]: value });
      expect(result.ok, field).toBe(false);
    }
  });

  it("counts code points, so emoji don't count double", () => {
    const result = validateApplication({ ...validInput(), preferredName: "🦇".repeat(60) });
    expect(result.ok).toBe(true);
  });

  it("rejects non-string field values", () => {
    const result = validateApplication({ ...validInput(), cpu: { evil: true } });
    expect(result.ok).toBe(false);
  });

  it("validates Discord usernames", () => {
    const ok = ["wren", "@Wren.Hunter", "  wren_99  ", "a.b_c"];
    const bad = ["w", "wren#1234", "Wren Hunter", "wren..hunter", "wrén", "a".repeat(33)];
    for (const name of ok) expect(validateApplication({ ...validInput(), discordUsername: name }).ok, name).toBe(true);
    for (const name of bad) expect(validateApplication({ ...validInput(), discordUsername: name }).ok, name).toBe(false);
  });

  it("validates optional email only when given", () => {
    expect(validateApplication({ ...validInput(), email: "wren@example.com" }).ok).toBe(true);
    expect(validateApplication({ ...validInput(), email: "not-an-email" }).ok).toBe(false);
  });
});

describe("sanitizeText", () => {
  it("strips control and invisible characters and trims", () => {
    expect(sanitizeText("  a\u0000b‮c​  ", true)).toBe("abc");
  });
  it("folds newlines in single-line fields and limits blank lines in long ones", () => {
    expect(sanitizeText("a\nb", true)).toBe("a b");
    expect(sanitizeText("a\r\n\n\n\n\nb", false)).toBe("a\n\nb");
  });
});

describe("normalizeDiscordUsername", () => {
  it("matches the database's generated column rule", () => {
    expect(normalizeDiscordUsername("  @@Wren.Hunter ")).toBe("wren.hunter");
  });
});

describe("checkSpamSignals", () => {
  it("rejects a filled honeypot", () => {
    expect(checkSpamSignals({ website: "http://spam", elapsedMs: 60000 })).toEqual({ ok: false, reason: "honeypot" });
  });
  it("rejects instant or missing fill times", () => {
    expect(checkSpamSignals({ website: "", elapsedMs: MIN_FILL_MS - 1 })).toEqual({ ok: false, reason: "too_fast" });
    expect(checkSpamSignals({ website: "" })).toEqual({ ok: false, reason: "too_fast" });
  });
  it("passes a normal submission", () => {
    expect(checkSpamSignals({ website: "", elapsedMs: 90000 })).toEqual({ ok: true });
  });
});
