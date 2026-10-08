import { describe, expect, it, vi } from "vitest";
import { buildCrashPost, validateCrash } from "../supabase/functions/_shared/crash.ts";
import {
  buildForumMultipart,
  embedSize,
  type ForumPostPayload,
  neutralizeThreadName,
  parseForumTags,
  pickTags,
  sendDiscordForumPost,
} from "../supabase/functions/_shared/discord-forum.ts";
import { buildFeedbackPost, validateFeedback } from "../supabase/functions/_shared/feedback.ts";
import { crashBody, feedbackBody } from "./fixtures.ts";

const payload = (): ForumPostPayload => ({
  username: "Hexenbane Bug Reports",
  thread_name: "A bug",
  allowed_mentions: { parse: [] },
  embeds: [{ title: "t", description: "d", color: 1, fields: [], footer: { text: "f" }, timestamp: "2026-10-08T12:00:00.000Z" }],
});

describe("forum thread names", () => {
  it("breaks mentions, stays on one line and fits 100 characters", () => {
    const name = neutralizeThreadName("@everyone\nlook <@&123456789012345678> " + "x".repeat(200));
    expect(name).not.toMatch(/@everyone|<@&\d+>|\n/);
    expect(Array.from(name).length).toBeLessThanOrEqual(100);
    expect(name.endsWith("…")).toBe(true);
  });

  it("keeps ordinary titles literal (no markdown escapes)", () => {
    expect(neutralizeThreadName("Card_art (Night 2) - overlaps")).toBe("Card_art (Night 2) - overlaps");
  });
});

describe("forum tags", () => {
  it("reads DISCORD_BUG_REPORTS_TAGS and ignores junk", () => {
    expect(parseForumTags('{"New":"1234567890","Crash":"9876543210","UI":"oops","Combat":5}')).toEqual({
      New: "1234567890",
      Crash: "9876543210",
    });
    expect(parseForumTags("not json")).toEqual({});
    expect(parseForumTags("[1,2]")).toEqual({});
    expect(parseForumTags(undefined)).toEqual({});
  });

  it("applies New plus the matching tag, skipping missing ones", () => {
    expect(pickTags({ New: "11111", Crash: "22222" }, ["Crash"])).toEqual(["11111", "22222"]);
    expect(pickTags({ Crash: "22222" }, ["Crash", "Combat"])).toEqual(["22222"]);
    expect(pickTags({}, ["UI"])).toEqual([]);
  });
});

describe("multipart forum posts", () => {
  it("sends payload_json plus files[n], listed as attachments", async () => {
    const form = buildForumMultipart(payload(), [
      { filename: "screenshot.jpg", contentType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
      { filename: "game-log.txt", contentType: "text/plain; charset=utf-8", data: "hello log" },
    ]);
    const message = JSON.parse(form.get("payload_json") as string);
    expect(message.thread_name).toBe("A bug");
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.attachments).toEqual([{ id: 0, filename: "screenshot.jpg" }, { id: 1, filename: "game-log.txt" }]);
    const shot = form.get("files[0]") as File;
    const log = form.get("files[1]") as File;
    expect(shot.name).toBe("screenshot.jpg");
    expect(shot.type).toBe("image/jpeg");
    expect(new Uint8Array(await shot.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    expect(log.name).toBe("game-log.txt");
    expect(await log.text()).toBe("hello log");
  });

  it("has no files entries when there are no files", () => {
    const form = buildForumMultipart(payload(), []);
    expect([...form.keys()]).toEqual(["payload_json"]);
  });
});

describe("sendDiscordForumPost", () => {
  const url = "https://discord.com/api/webhooks/123456789012345678/abcDEF-123_xyz";

  it("posts multipart with wait=true", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(FormData);
      return new Response("{}", { status: 200 });
    });
    const result = await sendDiscordForumPost(url, payload(), [], fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${url}?wait=true`, expect.objectContaining({ method: "POST" }));
  });

  it("never throws and never echoes the webhook URL", async () => {
    const results = [
      await sendDiscordForumPost(url, payload(), [], (() => Promise.reject(new TypeError("down"))) as unknown as typeof fetch),
      await sendDiscordForumPost(url, payload(), [], (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch),
      await sendDiscordForumPost(undefined, payload()),
      await sendDiscordForumPost("https://evil.example/api/webhooks/1/x", payload()),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain("abcDEF");
    }
  });
});

describe("report embeds stay within Discord's limits", () => {
  it("feedback with maximum-length, markdown-heavy text", () => {
    const result = validateFeedback(feedbackBody({ title: "*".repeat(90), details: "_[".repeat(2000) }));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { payload } = buildFeedbackPost(result.value, { reportId: "BR-7KQ3XM", tags: {}, at: "2026-10-08T12:00:00.000Z" });
    const embed = payload.embeds[0];
    expect(embedSize(embed)).toBeLessThanOrEqual(6000);
    expect(Array.from(embed.description).length).toBeLessThanOrEqual(4096);
    expect(Array.from(embed.title).length).toBeLessThanOrEqual(256);
    for (const f of embed.fields) expect(Array.from(f.value).length).toBeLessThanOrEqual(1024);
    expect(payload.thread_name.length).toBeLessThanOrEqual(100);
  });

  it("crash with maximum-length message and stack", () => {
    const result = validateCrash(crashBody({ message: "`".repeat(2000), stack: "#-\n".repeat(2666) }));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { payload } = buildCrashPost(result.value, {
      reportId: "CR-7KQ3XM",
      signature: "a".repeat(64),
      tags: {},
      at: "2026-10-08T12:00:00.000Z",
    });
    expect(embedSize(payload.embeds[0])).toBeLessThanOrEqual(6000);
    expect(Array.from(payload.embeds[0].description).length).toBeLessThanOrEqual(4096);
  });
});
