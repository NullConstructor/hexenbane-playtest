// Turns server-config.ts into concrete Discord permissions, and simulates how Discord resolves
// them so the layout can be checked (who sees what) without touching a real server.

import { PermissionFlagsBits } from "discord.js";
import type { Audience, CategoryConfig, ChannelConfig, ChannelKind, PermissionName, RoleKey, ServerConfig } from "../server-config.ts";

export const P = PermissionFlagsBits;

export function bits(names: readonly PermissionName[]): bigint {
  return names.reduce((acc, name) => acc | P[name], 0n);
}

export function names(value: bigint): PermissionName[] {
  return (Object.keys(P) as PermissionName[]).filter((name) => (value & P[name]) === P[name] && P[name] !== 0n);
}

/** Who an overwrite targets. "bot" is the provisioning bot's own member overwrite. */
export type Target = { kind: "everyone" } | { kind: "role"; key: RoleKey } | { kind: "bot" };

export interface DesiredOverwrite {
  target: Target;
  allow: bigint;
  deny: bigint;
}

export const targetId = (t: Target) => (t.kind === "role" ? `role:${t.key}` : t.kind);

const VIEW_TEXT = P.ViewChannel | P.ReadMessageHistory;
const VIEW_VOICE = P.ViewChannel | P.Connect;
const SEND = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
const MANAGE = P.ManageMessages | P.ManageThreads;
/** What the bot keeps on every hidden channel so it can still fix them on a later run. */
export const BOT_CHANNEL_ACCESS = P.ViewChannel | P.ManageChannels | P.ManageRoles;

export interface ResolvedChannel {
  view: Audience[];
  post: Audience[];
  manage: RoleKey[];
}

export function resolveChannel(category: CategoryConfig, channel: ChannelConfig): ResolvedChannel {
  const view = channel.view ?? category.view;
  const post = channel.post ?? view;
  return { view, post, manage: channel.manage ?? category.manage ?? [] };
}

/**
 * The complete set of overwrites for a channel (or a category, with kind "category").
 * Only @everyone, roles from the config and the bot appear; anything else on a real channel
 * is left untouched.
 */
export function channelOverwrites(
  resolved: ResolvedChannel,
  kind: ChannelKind | "category",
): DesiredOverwrite[] {
  const isVoice = kind === "voice";
  const view = isVoice ? VIEW_VOICE : VIEW_TEXT;
  const map = new Map<string, DesiredOverwrite>();
  const get = (target: Target) => {
    const id = targetId(target);
    if (!map.has(id)) map.set(id, { target, allow: 0n, deny: 0n });
    return map.get(id)!;
  };
  const role = (key: RoleKey): Target => ({ kind: "role", key });

  const isPublic = resolved.view.includes("everyone");
  if (!isPublic) {
    get({ kind: "everyone" }).deny |= view;
    for (const a of resolved.view) if (a !== "everyone") get(role(a)).allow |= view;
    // The bot must keep seeing the channels it hides, or it can't manage them later.
    get({ kind: "bot" }).allow |= BOT_CHANNEL_ACCESS | (isVoice ? P.Connect : 0n);
  }

  // Read-only for everyone who can view but isn't listed in `post`.
  const restrictPosting = !isVoice && kind !== "category" && !resolved.post.includes("everyone");
  const viewers = new Set(resolved.view);
  const postersCoverViewers = [...viewers].every((a) => resolved.post.includes(a));
  if (restrictPosting && !postersCoverViewers) {
    get({ kind: "everyone" }).deny |= SEND;
    for (const a of resolved.post) {
      if (a === "everyone") continue;
      const o = get(role(a));
      o.allow |= SEND;
      if (!isPublic) o.allow |= view; // posting implies seeing
    }
  }

  if (!isVoice) for (const key of resolved.manage) get(role(key)).allow |= MANAGE | (isPublic ? 0n : view);

  // A role that was only meant to manage must not gain sight of a hidden channel by accident.
  if (!isPublic) {
    for (const o of map.values()) {
      if (o.target.kind === "role" && !viewers.has(o.target.key) && !resolved.post.includes(o.target.key)) {
        o.allow &= ~(view | MANAGE | SEND);
      }
    }
  }
  return [...map.values()].filter((o) => o.allow !== 0n || o.deny !== 0n);
}

export function categoryOverwrites(category: CategoryConfig): DesiredOverwrite[] {
  return channelOverwrites({ view: category.view, post: category.view, manage: category.manage ?? [] }, "category");
}

// ── Simulation of Discord's permission rules ────────────────────────────────

export interface SimRole {
  key: RoleKey | "everyone";
  permissions: bigint;
}

/**
 * Discord's algorithm: base = @everyone | member's roles (Administrator = everything); then the
 * channel's @everyone overwrite, then all the member's role overwrites together (deny, then
 * allow), then the member's own overwrite. No View Channel means no access at all.
 */
export function effectivePermissions(
  everyoneBase: bigint,
  memberRoles: { key: RoleKey; permissions: bigint }[],
  overwrites: DesiredOverwrite[],
  isBot = false,
): bigint {
  let perms = memberRoles.reduce((acc, r) => acc | r.permissions, everyoneBase);
  if (perms & P.Administrator) return ~0n;
  const find = (pred: (t: Target) => boolean) => overwrites.filter((o) => pred(o.target));
  for (const o of find((t) => t.kind === "everyone")) perms = (perms & ~o.deny) | o.allow;
  const keys = new Set(memberRoles.map((r) => r.key));
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of find((t) => t.kind === "role" && keys.has(t.key))) {
    roleAllow |= o.allow;
    roleDeny |= o.deny;
  }
  perms = (perms & ~roleDeny) | roleAllow;
  if (isBot) for (const o of find((t) => t.kind === "bot")) perms = (perms & ~o.deny) | o.allow;
  if (!(perms & P.ViewChannel)) return 0n;
  return perms;
}

/** Discord's default @everyone permissions for a new server, minus what the config removes. */
export const DISCORD_DEFAULT_EVERYONE = bits([
  "ViewChannel",
  "CreateInstantInvite",
  "ChangeNickname",
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePublicThreads",
  "CreatePrivateThreads",
  "EmbedLinks",
  "AttachFiles",
  "AddReactions",
  "UseExternalEmojis",
  "UseExternalStickers",
  "MentionEveryone",
  "ReadMessageHistory",
  "UseApplicationCommands",
  "Connect",
  "Speak",
  "Stream",
  "UseVAD",
]);

export function everyoneBase(config: ServerConfig, current = DISCORD_DEFAULT_EVERYONE): bigint {
  return current & ~bits(config.everyoneRemove);
}

/**
 * Everything the bot must hold to create this layout. Discord only lets a bot grant (or deny)
 * permissions it has itself, so this is the union of every role permission and every overwrite
 * in the config, plus Manage Roles and Manage Channels.
 */
export function requiredBotPermissions(config: ServerConfig): bigint {
  let need = P.ViewChannel | P.ManageChannels | P.ManageRoles | P.ReadMessageHistory | P.Connect;
  for (const role of config.roles) need |= bits(role.permissions);
  need |= bits(config.everyoneRemove);
  for (const category of config.categories) {
    for (const o of categoryOverwrites(category)) need |= o.allow | o.deny;
    for (const channel of category.channels) {
      for (const o of channelOverwrites(resolveChannel(category, channel), channel.kind)) need |= o.allow | o.deny;
    }
  }
  return need;
}
