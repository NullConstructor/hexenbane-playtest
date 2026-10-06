import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module without types
import { canonicalize, parseAgreement } from "../scripts/agreement.mjs";
import { AGREEMENT_SHA256, AGREEMENT_TEXT, AGREEMENT_VERSION } from "../supabase/functions/_shared/agreement.generated.ts";

describe("Private Playtest Agreement", () => {
  it("generated hash is the SHA-256 of the generated text", () => {
    expect(createHash("sha256").update(AGREEMENT_TEXT, "utf8").digest("hex")).toBe(AGREEMENT_SHA256);
  });

  it("generated module matches the current agreement file", () => {
    const { current } = JSON.parse(readFileSync("legal/current.json", "utf8"));
    const parsed = parseAgreement(readFileSync(`legal/${current}`, "utf8"), current);
    expect(parsed.version).toBe(AGREEMENT_VERSION);
    expect(parsed.sha256).toBe(AGREEMENT_SHA256);
  });

  it("hash ignores Windows line endings but not wording", () => {
    const raw = readFileSync("legal/playtest-agreement-v1.md", "utf8");
    const a = parseAgreement(raw, "a.md");
    const b = parseAgreement(raw.replace(/\n/g, "\r\n"), "b.md");
    const c = parseAgreement(raw.replace("confidential", "secret"), "c.md");
    expect(b.sha256).toBe(a.sha256);
    expect(c.sha256).not.toBe(a.sha256);
    expect(canonicalize("x\r\n\r\n")).toBe("x\n");
  });

  it("covers the points the playtest needs", () => {
    const text = AGREEMENT_TEXT.toLowerCase();
    for (const phrase of ["confidential", "personal", "redistribute", "stream", "videos", "screenshots", "unreleased", "assets", "reverse engineer", "law", "belongs", "revoke", "bugs", "voluntary", "feedback", "does not transfer"]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("rejects bad front matter", () => {
    expect(() => parseAgreement("no front matter", "x.md")).toThrow();
    expect(() => parseAgreement("---\nversion: v1\neffective: 2026-10-06\n---\ntext", "x.md")).toThrow();
  });
});
