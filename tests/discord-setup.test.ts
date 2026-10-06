import { describe, expect, it } from "vitest";
import { serverConfig } from "../discord/server-config.ts";
import { accessMatrix } from "../discord/src/matrix.ts";
import {
  bits,
  BOT_CHANNEL_ACCESS,
  DISCORD_DEFAULT_EVERYONE,
  effectivePermissions,
  P,
  requiredBotPermissions,
  type Target,
} from "../discord/src/permissions.ts";
import { type Action, buildPlan, type SnapChannel, type Snapshot } from "../discord/src/plan.ts";

const rows = accessMatrix(serverConfig);
const byCategory = (name: string) => rows.filter((r) => r.category === name);
const row = (channel: string) => rows.find((r) => r.channel === channel)!;

describe("who can see what", () => {
  it("hides PLAYTEST OPERATIONS from everyone but Developer and Playtest Manager", () => {
    for (const r of byCategory("PLAYTEST OPERATIONS")) {
      for (const persona of ["Member", "Hunter", "Early Supporter", "Playtester", "Artist", "Composer", "Moderator"]) {
        expect(r.access[persona], `${persona} ${r.channel}`).toBe("none");
      }
      expect(r.access["Developer"]).not.toBe("none");
      expect(r.access["Playtest Manager"]).not.toBe("none");
    }
  });

  it("shows PRIVATE PLAYTEST only to Playtesters and playtest staff", () => {
    for (const r of byCategory("PRIVATE PLAYTEST")) {
      for (const persona of ["Member", "Hunter", "Early Supporter", "Artist", "Composer"]) expect(r.access[persona], `${persona} ${r.channel}`).toBe("none");
      for (const persona of ["Playtester", "Developer", "Playtest Manager"]) expect(r.access[persona], `${persona} ${r.channel}`).not.toBe("none");
    }
    expect(row("Playtest Session").access["Member"]).toBe("none");
    expect(row("Playtest Session").access["Playtester"]).toBe("write");
  });

  it("makes #build-downloads read-only for Playtesters; only playtest staff can post", () => {
    const r = row("#build-downloads").access;
    expect(r["Playtester"]).toBe("read");
    expect(r["Moderator"]).toMatch(/^read/);
    expect(r["Developer"]).toMatch(/^write/);
    expect(r["Playtest Manager"]).toMatch(/^write/);
    expect(r["Member"]).toBe("none");
  });

  it("hides INTERNAL DEVELOPMENT from the community, Playtesters and moderators", () => {
    for (const r of [...byCategory("INTERNAL DEVELOPMENT"), row("Dev Room")]) {
      for (const persona of ["Member", "Hunter", "Early Supporter", "Playtester", "Moderator", "Playtest Manager"]) {
        expect(r.access[persona], `${persona} ${r.channel}`).toBe("none");
      }
      expect(r.access["Artist"]).not.toBe("none");
      expect(r.access["Composer"]).not.toBe("none");
      expect(r.access["Developer"]).not.toBe("none");
    }
  });

  it("gives creative collaborators no moderation anywhere", () => {
    for (const r of rows) {
      expect(r.access["Artist"], r.channel).not.toMatch(/moderate/);
      expect(r.access["Composer"], r.channel).not.toMatch(/moderate/);
    }
    for (const key of ["artist", "composer", "playtester", "earlySupporter", "hunter"]) {
      expect(serverConfig.roles.find((r) => r.key === key)!.permissions).toEqual([]);
    }
  });

  it("keeps read-only channels read-only for members", () => {
    for (const channel of ["#welcome", "#rules-and-info", "#announcements", "#faq", "#dev-updates", "#patch-notes", "#playtest-info", "#playtest-announcements"]) {
      expect(row(channel).access[channel.startsWith("#playtest") ? "Playtester" : "Member"], channel).toBe("read");
    }
    expect(row("#general").access["Member"]).toBe("write");
  });

  it("never grants Administrator and stops members pinging @everyone", () => {
    for (const role of serverConfig.roles) expect(role.permissions).not.toContain("Administrator");
    expect(requiredBotPermissions(serverConfig) & P.Administrator).toBe(0n);
    expect(serverConfig.everyoneRemove).toContain("MentionEveryone");
  });

  it("keeps the bot able to see the channels it hides", () => {
    const hidden = rows.filter((r) => r.access["Member"] === "none");
    expect(hidden.length).toBeGreaterThan(10);
    const ops = serverConfig.categories.find((c) => c.name === "PLAYTEST OPERATIONS")!;
    const plan = buildPlan(serverConfig, emptyServer());
    const create = plan.actions.find((a) => a.type === "create-channel" && a.channel.name === ops.channels[0].name) as Extract<Action, { type: "create-channel" }>;
    const perms = effectivePermissions(DISCORD_DEFAULT_EVERYONE, [], create.overwrites, true);
    expect(perms & BOT_CHANNEL_ACCESS).toBe(BOT_CHANNEL_ACCESS);
  });
});

// ── A tiny in-memory Discord, to prove the plan converges and is conservative ──

function emptyServer(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    guildName: "Hexenbane",
    everyoneId: "1",
    botUserId: "999",
    botTopRolePosition: 50,
    botPermissions: requiredBotPermissions(serverConfig),
    everyonePermissions: DISCORD_DEFAULT_EVERYONE,
    community: true,
    roles: [{ id: "900", name: "Hexenbane Setup", position: 50, permissions: requiredBotPermissions(serverConfig), managed: true }],
    channels: [
      { id: "10", name: "Text Channels", kind: "category", parentId: null, position: 0, topic: null, overwrites: [], tags: [] },
      { id: "11", name: "general", kind: "text", parentId: "10", position: 0, topic: null, overwrites: [], tags: [] },
      { id: "12", name: "rules", kind: "text", parentId: "10", position: 1, topic: null, overwrites: [], tags: [] },
      { id: "13", name: "moderator-only", kind: "text", parentId: "10", position: 2, topic: null, overwrites: [{ id: "1", type: "role", allow: 0n, deny: P.ViewChannel }], tags: [] },
      { id: "20", name: "Voice Channels", kind: "category", parentId: null, position: 1, topic: null, overwrites: [], tags: [] },
      { id: "21", name: "General", kind: "voice", parentId: "20", position: 0, topic: null, overwrites: [], tags: [] },
    ],
    ...extra,
  };
}

function simulate(snap: Snapshot, actions: Action[]): Snapshot {
  const next: Snapshot = structuredClone(snap);
  let nextId = 1000;
  const roleId = (t: Target) => {
    if (t.kind === "everyone") return next.everyoneId;
    if (t.kind === "bot") return next.botUserId;
    return next.roles.find((r) => r.name === serverConfig.roles.find((c) => c.key === t.key)!.name)!.id;
  };
  const toSnap = (o: { target: Target; allow: bigint; deny: bigint }) => ({
    id: roleId(o.target),
    type: o.target.kind === "bot" ? ("member" as const) : ("role" as const),
    allow: o.allow,
    deny: o.deny,
  });
  const setOverwrites = (c: SnapChannel, overwrites: { target: Target; allow: bigint; deny: bigint }[]) => {
    const managedIds = new Set([next.everyoneId, next.botUserId, ...serverConfig.roles.map((r) => next.roles.find((x) => x.name === r.name)?.id)]);
    c.overwrites = [...c.overwrites.filter((o) => !managedIds.has(o.id)), ...overwrites.map(toSnap)];
  };
  for (const a of actions) {
    switch (a.type) {
      case "everyone-permissions":
        next.everyonePermissions &= ~a.remove;
        break;
      case "create-role":
        next.roles.push({ id: String(nextId++), name: a.role.name, position: 1, permissions: bits(a.role.permissions), managed: false });
        break;
      case "order-roles": {
        const managed = a.order.map((key) => next.roles.find((r) => r.name === serverConfig.roles.find((c) => c.key === key)!.name)!);
        const slots = managed.map((r) => r.position).sort((x, y) => y - x);
        // positions may tie for fresh roles; give them distinct slots below the bot
        managed.forEach((r, i) => (r.position = slots[i] === slots[i + 1] || slots[i] === slots[i - 1] ? 40 - i : slots[i]));
        break;
      }
      case "role-permissions":
        next.roles.find((r) => r.id === a.roleId)!.permissions = a.to;
        break;
      case "create-category":
        next.channels.push({ id: String(nextId++), name: a.name, kind: "category", parentId: null, position: next.channels.length, topic: null, overwrites: a.overwrites.map(toSnap), tags: [] });
        break;
      case "create-channel": {
        const parent = next.channels.find((c) => c.kind === "category" && c.name === a.category)!;
        const count = next.channels.filter((c) => c.parentId === parent.id).length;
        next.channels.push({
          id: String(nextId++),
          name: a.kind === "voice" ? a.channel.name : a.channel.name.toLowerCase(),
          kind: a.kind,
          parentId: parent.id,
          position: count,
          topic: a.channel.topic ?? null,
          overwrites: a.overwrites.map(toSnap),
          tags: a.channel.tags ?? [],
        });
        break;
      }
      case "move-channel": {
        const parent = next.channels.find((c) => c.kind === "category" && c.name === a.category)!;
        next.channels.find((c) => c.id === a.channelId)!.parentId = parent.id;
        break;
      }
      case "category-overwrites":
      case "channel-overwrites":
        setOverwrites(next.channels.find((c) => c.id === a.channelId)!, a.overwrites);
        break;
      case "add-forum-tags":
        next.channels.find((c) => c.id === a.channelId)!.tags.push(...a.tags);
        break;
      case "set-topic":
        next.channels.find((c) => c.id === a.channelId)!.topic = a.topic;
        break;
      case "order-channels": {
        const parent = next.channels.find((c) => c.kind === "category" && c.name === a.category)!;
        const order = a.order.map((n) => n.toLowerCase());
        const inside = next.channels.filter((c) => c.parentId === parent.id && order.includes(c.name.toLowerCase()));
        const slots = inside.map((c) => c.position).sort((x, y) => x - y);
        inside.sort((x, y) => order.indexOf(x.name.toLowerCase()) - order.indexOf(y.name.toLowerCase())).forEach((c, i) => (c.position = slots[i]));
        break;
      }
    }
  }
  return next;
}

describe("provisioning plan", () => {
  it("builds the whole server from a blank Community server", () => {
    const plan = buildPlan(serverConfig, emptyServer());
    expect(plan.blockers).toEqual([]);
    const count = (t: Action["type"]) => plan.actions.filter((a) => a.type === t).length;
    expect(count("create-role")).toBe(serverConfig.roles.length);
    expect(count("create-category")).toBe(serverConfig.categories.length);
    const totalChannels = serverConfig.categories.reduce((n, c) => n + c.channels.length, 0);
    // #general already exists and is adopted instead of duplicated
    expect(count("create-channel")).toBe(totalChannels - 1);
    expect(plan.actions).toContainEqual(expect.objectContaining({ type: "move-channel", name: "general", category: "THE CHAPTER HOUSE" }));
    expect(count("everyone-permissions")).toBe(1);
  });

  it("is idempotent: after applying, a second run has nothing to do", () => {
    const first = buildPlan(serverConfig, emptyServer());
    const after = simulate(emptyServer(), first.actions);
    const second = buildPlan(serverConfig, after);
    expect(second.actions).toEqual([]);
    expect(second.blockers).toEqual([]);
  });

  it("never touches channels and roles it doesn't manage", () => {
    const before = emptyServer({
      roles: [
        ...emptyServer().roles,
        { id: "700", name: "Server Booster", position: 3, permissions: 0n, managed: true },
        { id: "701", name: "Friends", position: 2, permissions: P.ManageMessages, managed: false },
      ],
    });
    const plan = buildPlan(serverConfig, before);
    const touched = new Set(plan.actions.flatMap((a) => ("channelId" in a ? [a.channelId] : [])));
    for (const id of ["12", "13", "21"]) expect(touched.has(id), id).toBe(false);
    const after = simulate(before, plan.actions);
    expect(after.roles.find((r) => r.id === "701")).toEqual(before.roles.find((r) => r.id === "701"));
    for (const id of ["10", "12", "13", "20", "21"]) expect(after.channels.find((c) => c.id === id)).toBeTruthy();
    expect(after.channels.find((c) => c.id === "13")!.overwrites).toEqual(before.channels.find((c) => c.id === "13")!.overwrites);
  });

  it("repairs a hidden channel someone opened to the public", () => {
    const built = simulate(emptyServer(), buildPlan(serverConfig, emptyServer()).actions);
    const apps = built.channels.find((c) => c.name === "playtest-applications")!;
    apps.overwrites = apps.overwrites.filter((o) => o.id !== built.everyoneId);
    const plan = buildPlan(serverConfig, built);
    const fix = plan.actions.find((a) => a.type === "channel-overwrites" && a.name === "playtest-applications");
    expect(fix).toBeTruthy();
    expect((fix as Extract<Action, { type: "channel-overwrites" }>).changes.join(" ")).toContain("deny ViewChannel");
  });

  it("reports role permission drift without changing it unless asked", () => {
    const built = simulate(emptyServer(), buildPlan(serverConfig, emptyServer()).actions);
    built.roles.find((r) => r.name === "Playtester")!.permissions = P.Administrator;
    const plan = buildPlan(serverConfig, built);
    expect(plan.actions.some((a) => a.type === "role-permissions")).toBe(false);
    expect(plan.warnings.join(" ")).toContain("Playtester");
    const fixing = buildPlan(serverConfig, built, { fixRolePermissions: true });
    expect(fixing.actions).toContainEqual(expect.objectContaining({ type: "role-permissions", to: 0n }));
  });

  it("refuses to apply when the bot lacks permissions or sits below a managed role", () => {
    const weak = buildPlan(serverConfig, emptyServer({ botPermissions: P.ManageChannels | P.ManageRoles | P.ViewChannel }));
    expect(weak.blockers.join(" ")).toContain("missing permissions");
    const built = simulate(emptyServer(), buildPlan(serverConfig, emptyServer()).actions);
    built.roles.find((r) => r.name === "Developer")!.position = 60;
    expect(buildPlan(serverConfig, built).blockers.join(" ")).toContain("Developer");
  });

  it("falls back to a read-only text channel for announcements without Community", () => {
    const plan = buildPlan(serverConfig, emptyServer({ community: false }));
    const ann = plan.actions.find((a) => a.type === "create-channel" && a.channel.name === "announcements") as Extract<Action, { type: "create-channel" }>;
    expect(ann.kind).toBe("text");
    expect(plan.warnings.join(" ")).toContain("Community");
  });
});
