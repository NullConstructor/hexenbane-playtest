// Compares server-config.ts with a snapshot of the real server and lists the changes needed.
// Pure: no Discord calls, so it can be tested and printed as a dry run.

import type { CategoryConfig, ChannelConfig, ChannelKind, RoleConfig, RoleKey, ServerConfig } from "../server-config.ts";
import {
  bits,
  categoryOverwrites,
  channelOverwrites,
  type DesiredOverwrite,
  names,
  P,
  requiredBotPermissions,
  resolveChannel,
  type Target,
  targetId,
} from "./permissions.ts";

export type SnapKind = ChannelKind | "category" | "other";

export interface SnapOverwrite {
  id: string;
  type: "role" | "member";
  allow: bigint;
  deny: bigint;
}

export interface SnapRole {
  id: string;
  name: string;
  position: number;
  permissions: bigint;
  /** Managed by an integration (bots, boosts): never touched. */
  managed: boolean;
}

export interface SnapChannel {
  id: string;
  name: string;
  kind: SnapKind;
  parentId: string | null;
  position: number;
  topic: string | null;
  overwrites: SnapOverwrite[];
  tags: string[];
}

export interface Snapshot {
  guildName: string;
  everyoneId: string;
  botUserId: string;
  /** Position of the bot's highest role. It can only manage roles below this. */
  botTopRolePosition: number;
  botPermissions: bigint;
  everyonePermissions: bigint;
  community: boolean;
  roles: SnapRole[];
  channels: SnapChannel[];
}

export type Action =
  | { type: "everyone-permissions"; remove: bigint }
  | { type: "create-role"; role: RoleConfig }
  | { type: "role-permissions"; key: RoleKey; roleId: string; to: bigint; added: bigint; removed: bigint }
  | { type: "order-roles"; order: RoleKey[] }
  | { type: "create-category"; name: string; overwrites: DesiredOverwrite[] }
  | { type: "category-overwrites"; channelId: string; name: string; overwrites: DesiredOverwrite[]; changes: string[] }
  | { type: "create-channel"; category: string; channel: ChannelConfig; kind: ChannelKind; overwrites: DesiredOverwrite[] }
  | { type: "move-channel"; channelId: string; name: string; from: string; category: string }
  | { type: "channel-overwrites"; channelId: string; name: string; overwrites: DesiredOverwrite[]; changes: string[] }
  | { type: "add-forum-tags"; channelId: string; name: string; tags: string[] }
  | { type: "set-topic"; channelId: string; name: string; topic: string }
  | { type: "order-channels"; category: string; order: string[] };

export interface Plan {
  actions: Action[];
  warnings: string[];
  /** Problems that make --apply unsafe. */
  blockers: string[];
}

export interface PlanOptions {
  fixRolePermissions?: boolean;
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** Discord stores text channel names lower-case with dashes; voice names keep their spelling. */
export function discordChannelName(name: string, kind: ChannelKind): string {
  return kind === "voice" ? name : name.toLowerCase().replace(/\s+/g, "-");
}

function kindFamily(kind: SnapKind): string {
  return kind === "text" || kind === "announcement" ? "text" : kind;
}

function describeTarget(t: Target, config: ServerConfig): string {
  if (t.kind === "everyone") return "@everyone";
  if (t.kind === "bot") return "provisioning bot";
  return config.roles.find((r) => r.key === t.key)?.name ?? t.key;
}

/** Overwrite differences for the targets this script manages; others are ignored. */
export function overwriteChanges(
  desired: DesiredOverwrite[],
  existing: SnapOverwrite[],
  resolveId: (t: Target) => string | null,
  managedTargets: Target[],
  config: ServerConfig,
): string[] {
  const changes: string[] = [];
  for (const target of managedTargets) {
    const want = desired.find((o) => targetId(o.target) === targetId(target)) ?? { target, allow: 0n, deny: 0n };
    const id = resolveId(target);
    if (id === null) {
      if (want.allow || want.deny) changes.push(`${describeTarget(target, config)}: set (role will be created)`);
      continue;
    }
    const have = existing.find((o) => o.id === id) ?? { allow: 0n, deny: 0n };
    if (have.allow === want.allow && have.deny === want.deny) continue;
    const parts: string[] = [];
    const add = want.allow & ~have.allow;
    const unallow = have.allow & ~want.allow;
    const deny = want.deny & ~have.deny;
    const undeny = have.deny & ~want.deny;
    if (add) parts.push(`allow ${names(add).join(", ")}`);
    if (deny) parts.push(`deny ${names(deny).join(", ")}`);
    if (unallow) parts.push(`stop allowing ${names(unallow).join(", ")}`);
    if (undeny) parts.push(`stop denying ${names(undeny).join(", ")}`);
    changes.push(`${describeTarget(target, config)}: ${parts.join("; ")}`);
  }
  return changes;
}

export function buildPlan(config: ServerConfig, snap: Snapshot, options: PlanOptions = {}): Plan {
  const actions: Action[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // ── Bot permissions ────────────────────────────────────────────────────────
  const required = requiredBotPermissions(config);
  if (!(snap.botPermissions & P.Administrator)) {
    const missing = required & ~snap.botPermissions;
    if (missing) {
      blockers.push(
        `The bot is missing permissions it needs to grant: ${names(missing).join(", ")}. ` +
          `Re-invite it with the URL from \`npm run discord -- --invite-url\`, or add them to its role.`,
      );
    }
  } else {
    warnings.push("The bot has Administrator. It works, but remove Administrator after setup (see discord/README.md).");
  }

  // ── @everyone ──────────────────────────────────────────────────────────────
  const removeFromEveryone = snap.everyonePermissions & bits(config.everyoneRemove);
  if (removeFromEveryone) actions.push({ type: "everyone-permissions", remove: removeFromEveryone });

  // ── Roles ──────────────────────────────────────────────────────────────────
  const roleByKey = new Map<RoleKey, SnapRole>();
  for (const role of config.roles) {
    const matches = snap.roles.filter((r) => !r.managed && same(r.name, role.name));
    if (matches.length > 1) warnings.push(`There are ${matches.length} roles named "${role.name}"; using the highest one.`);
    const existing = matches.sort((a, b) => b.position - a.position)[0];
    if (!existing) {
      actions.push({ type: "create-role", role });
      continue;
    }
    roleByKey.set(role.key, existing);
    if (existing.position >= snap.botTopRolePosition) {
      blockers.push(
        `The role "${existing.name}" is above (or level with) the bot's role, so the bot can't manage it. ` +
          `In Server Settings → Roles, drag the bot's role above it.`,
      );
    }
    const want = bits(role.permissions);
    if (existing.permissions !== want) {
      const added = want & ~existing.permissions;
      const removed = existing.permissions & ~want;
      if (options.fixRolePermissions) {
        actions.push({ type: "role-permissions", key: role.key, roleId: existing.id, to: want, added, removed });
      } else {
        const parts = [
          added ? `missing ${names(added).join(", ")}` : "",
          removed ? `has extra ${names(removed).join(", ")}` : "",
        ].filter(Boolean);
        warnings.push(
          `Role "${existing.name}" permissions differ from the config (${parts.join("; ")}). ` +
            `Left as is; rerun with --fix-role-permissions to make them match.`,
        );
      }
    }
  }

  const created = actions.some((a) => a.type === "create-role");
  const present = config.roles.filter((r) => roleByKey.has(r.key));
  const outOfOrder = present.some((r, i) => i > 0 && roleByKey.get(present[i - 1].key)!.position < roleByKey.get(r.key)!.position);
  if (created || outOfOrder) actions.push({ type: "order-roles", order: config.roles.map((r) => r.key) });

  const resolveId = (t: Target): string | null => {
    if (t.kind === "everyone") return snap.everyoneId;
    if (t.kind === "bot") return snap.botUserId;
    return roleByKey.get(t.key)?.id ?? null;
  };
  const managedTargets: Target[] = [
    { kind: "everyone" },
    { kind: "bot" },
    ...config.roles.map((r): Target => ({ kind: "role", key: r.key })),
  ];

  // ── Categories and channels ────────────────────────────────────────────────
  const claimed = new Set<string>();
  for (const category of config.categories) {
    const existingCategory = snap.channels.find((c) => c.kind === "category" && same(c.name, category.name));
    const catOverwrites = categoryOverwrites(category);
    if (!existingCategory) {
      actions.push({ type: "create-category", name: category.name, overwrites: catOverwrites });
    } else {
      claimed.add(existingCategory.id);
      const changes = overwriteChanges(catOverwrites, existingCategory.overwrites, resolveId, managedTargets, config);
      if (changes.length) {
        actions.push({ type: "category-overwrites", channelId: existingCategory.id, name: category.name, overwrites: catOverwrites, changes });
      }
    }
    planChannels(category, existingCategory ?? null);
  }

  function planChannels(category: CategoryConfig, existingCategory: SnapChannel | null) {
    const orderNames: string[] = [];
    let needsOrdering = false;
    for (const channel of category.channels) {
      const discordName = discordChannelName(channel.name, channel.kind);
      orderNames.push(discordName);
      let kind: ChannelKind = channel.kind;
      if (kind === "announcement" && !snap.community) {
        warnings.push(`#${discordName}: announcement channels need Community mode; it will be a normal read-only text channel.`);
        kind = "text";
      }
      const overwrites = channelOverwrites(resolveChannel(category, channel), channel.kind);

      const candidates = snap.channels.filter(
        (c) => !claimed.has(c.id) && c.kind !== "category" && same(c.name, discordName),
      );
      const existing =
        candidates.find((c) => existingCategory && c.parentId === existingCategory.id && kindFamily(c.kind) === kindFamily(kind)) ??
        candidates.find((c) => kindFamily(c.kind) === kindFamily(kind)) ??
        candidates[0];

      if (!existing) {
        actions.push({ type: "create-channel", category: category.name, channel, kind, overwrites });
        // New channels land at the bottom of an existing category; a new category is built in order.
        if (existingCategory) needsOrdering = true;
        continue;
      }
      claimed.add(existing.id);

      if (kindFamily(existing.kind) !== kindFamily(kind)) {
        warnings.push(
          `#${existing.name} exists as a ${existing.kind} channel but the config wants ${kind}. ` +
            `It is used as it is; convert or replace it by hand if you want the ${kind} version.`,
        );
      } else if (existing.kind !== kind && kind === "announcement") {
        warnings.push(`#${existing.name} is a normal text channel; Discord can convert it in its settings (Announcement Channel toggle).`);
      }

      if (!existingCategory || existing.parentId !== existingCategory.id) {
        const from = snap.channels.find((c) => c.id === existing.parentId)?.name ?? "no category";
        actions.push({ type: "move-channel", channelId: existing.id, name: existing.name, from, category: category.name });
        needsOrdering = true;
      }
      const changes = overwriteChanges(overwrites, existing.overwrites, resolveId, managedTargets, config);
      if (changes.length) actions.push({ type: "channel-overwrites", channelId: existing.id, name: existing.name, overwrites, changes });

      if (channel.tags && existing.kind === "forum") {
        const missing = channel.tags.filter((t) => !existing.tags.some((have) => same(have, t)));
        if (missing.length) {
          if (existing.tags.length + missing.length > 20) warnings.push(`#${existing.name}: forum tag limit (20) reached; some tags were not added.`);
          const room = Math.max(0, 20 - existing.tags.length);
          if (room) actions.push({ type: "add-forum-tags", channelId: existing.id, name: existing.name, tags: missing.slice(0, room) });
        }
      }
      if (channel.topic && !existing.topic && existing.kind !== "voice") {
        actions.push({ type: "set-topic", channelId: existing.id, name: existing.name, topic: channel.topic });
      }
    }

    if (existingCategory && !needsOrdering) {
      const inCategory = snap.channels
        .filter((c) => c.parentId === existingCategory.id && orderNames.some((n) => same(n, c.name)))
        .sort((a, b) => a.position - b.position)
        .map((c) => c.name.toLowerCase());
      const wanted = orderNames.map((n) => n.toLowerCase()).filter((n) => inCategory.includes(n));
      if (inCategory.join("|") !== wanted.join("|")) needsOrdering = true;
    }
    if (needsOrdering) actions.push({ type: "order-channels", category: category.name, order: orderNames });
  }

  return { actions, warnings, blockers };
}

/** Human-readable dry-run lines. */
export function describeAction(action: Action, config: ServerConfig): string {
  const roleName = (key: RoleKey) => config.roles.find((r) => r.key === key)?.name ?? key;
  switch (action.type) {
    case "everyone-permissions":
      return `@everyone: remove ${names(action.remove).join(", ")}`;
    case "create-role":
      return `Create role "${action.role.name}"${action.role.permissions.length ? ` with ${action.role.permissions.join(", ")}` : " (no extra permissions)"}`;
    case "role-permissions":
      return `Role "${roleName(action.key)}": ${[
        action.added ? `add ${names(action.added).join(", ")}` : "",
        action.removed ? `remove ${names(action.removed).join(", ")}` : "",
      ].filter(Boolean).join("; ")}`;
    case "order-roles":
      return `Order roles (below the bot's role): ${action.order.map(roleName).join(" > ")}`;
    case "create-category":
      return `Create category ${action.name}`;
    case "category-overwrites":
      return `Category ${action.name} permissions:\n      ${action.changes.join("\n      ")}`;
    case "create-channel": {
      const label = action.kind === "voice" ? `🔊 ${action.channel.name}` : `#${discordChannelName(action.channel.name, action.kind)}`;
      return `Create ${action.kind} channel ${label} in ${action.category}`;
    }
    case "move-channel":
      return `Move existing #${action.name} from "${action.from}" into ${action.category}`;
    case "channel-overwrites":
      return `#${action.name} permissions:\n      ${action.changes.join("\n      ")}`;
    case "add-forum-tags":
      return `#${action.name}: add forum tags ${action.tags.join(", ")}`;
    case "set-topic":
      return `#${action.name}: set topic`;
    case "order-channels":
      return `Order channels in ${action.category}`;
  }
}
