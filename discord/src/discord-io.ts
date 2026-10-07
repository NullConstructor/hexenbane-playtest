// The only file that talks to Discord: reading a snapshot of the server and carrying out a plan.

import {
  ChannelType,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
  type PermissionOverwriteOptions,
  OverwriteType,
  type Role,
} from "discord.js";
import type { RoleKey, ServerConfig } from "../server-config.ts";
import { type DesiredOverwrite, names, type Target, targetId } from "./permissions.ts";
import { type Action, describeAction, discordChannelName, type SnapKind, type Snapshot } from "./plan.ts";

function kindOf(channel: GuildBasedChannel): SnapKind {
  switch (channel.type) {
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildVoice:
      return "voice";
    default:
      return "other";
  }
}

export async function takeSnapshot(guild: Guild): Promise<Snapshot> {
  const [roles, channels, me] = await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.members.fetchMe()]);
  return {
    guildName: guild.name,
    everyoneId: guild.roles.everyone.id,
    botUserId: me.id,
    botTopRolePosition: me.roles.highest.position,
    botPermissions: me.permissions.bitfield,
    everyonePermissions: guild.roles.everyone.permissions.bitfield,
    community: guild.features.includes("COMMUNITY"),
    roles: [...roles.values()]
      .filter((r) => r.id !== guild.roles.everyone.id)
      .map((r) => ({ id: r.id, name: r.name, position: r.position, permissions: r.permissions.bitfield, managed: r.managed })),
    channels: [...channels.values()]
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({
        id: c.id,
        name: c.name,
        kind: kindOf(c),
        parentId: c.parentId,
        position: "position" in c ? c.position : 0,
        topic: "topic" in c ? (c.topic ?? null) : null,
        overwrites: "permissionOverwrites" in c
          ? [...c.permissionOverwrites.cache.values()].map((o) => ({
            id: o.id,
            type: o.type === OverwriteType.Member ? ("member" as const) : ("role" as const),
            allow: o.allow.bitfield,
            deny: o.deny.bitfield,
          }))
          : [],
        tags: c.type === ChannelType.GuildForum ? (c as ForumChannel).availableTags.map((t) => t.name) : [],
      })),
  };
}

/** Bitfields → { Permission: true (allow) | false (deny) } for permissionOverwrites.create(). */
function toOptions(o: { allow: bigint; deny: bigint }): PermissionOverwriteOptions {
  const options: PermissionOverwriteOptions = {};
  for (const name of names(o.allow)) options[name] = true;
  for (const name of names(o.deny)) options[name] = false;
  return options;
}

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
} as const;

export interface ApplyLog {
  step(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
}

/** Carries out the plan in order. Stops at the first failure; rerunning picks up where it left off. */
export async function applyPlan(guild: Guild, config: ServerConfig, actions: Action[], snap: Snapshot, log: ApplyLog): Promise<void> {
  const roleIds = new Map<RoleKey, string>();
  for (const role of config.roles) {
    const existing = guild.roles.cache
      .filter((r) => !r.managed && r.name.localeCompare(role.name, undefined, { sensitivity: "accent" }) === 0)
      .sort((a, b) => b.position - a.position)
      .first();
    if (existing) roleIds.set(role.key, existing.id);
  }
  const categoryIds = new Map<string, string>();
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildCategory) {
      const match = config.categories.find((cat) => cat.name.localeCompare(c.name, undefined, { sensitivity: "accent" }) === 0);
      if (match && !categoryIds.has(match.name)) categoryIds.set(match.name, c.id);
    }
  }

  const resolve = (target: Target): string => {
    if (target.kind === "everyone") return guild.roles.everyone.id;
    if (target.kind === "bot") return snap.botUserId;
    const id = roleIds.get(target.key);
    if (!id) throw new Error(`Role ${target.key} does not exist yet`);
    return id;
  };
  const toDiscord = (overwrites: DesiredOverwrite[]): OverwriteResolvable[] =>
    overwrites.map((o) => ({
      id: resolve(o.target),
      type: o.target.kind === "bot" ? OverwriteType.Member : OverwriteType.Role,
      allow: o.allow,
      deny: o.deny,
    }));

  /** Rewrites only the overwrites this script manages; others on the channel are kept. */
  const reconcile = async (channelId: string, overwrites: DesiredOverwrite[]) => {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !("permissionOverwrites" in channel)) throw new Error(`Channel ${channelId} not found`);
    const managed: Target[] = [{ kind: "everyone" }, { kind: "bot" }, ...config.roles.map((r): Target => ({ kind: "role", key: r.key }))];
    for (const target of managed) {
      const want = overwrites.find((o) => targetId(o.target) === targetId(target));
      if (target.kind === "role" && !roleIds.has(target.key)) continue;
      const id = resolve(target);
      const have = channel.permissionOverwrites.cache.get(id);
      if (want) {
        if (have && have.allow.bitfield === want.allow && have.deny.bitfield === want.deny) continue;
        // create() replaces this one target's overwrite and leaves every other overwrite alone.
        await channel.permissionOverwrites.create(id, toOptions(want), {
          type: target.kind === "bot" ? OverwriteType.Member : OverwriteType.Role,
          reason: "Hexenbane provisioning",
        });
      } else if (have) {
        await channel.permissionOverwrites.delete(id, "Hexenbane provisioning");
      }
    }
  };

  for (const action of actions) {
    log.step(describeAction(action, config).split("\n")[0]);
    switch (action.type) {
      case "everyone-permissions": {
        const everyone = guild.roles.everyone;
        await everyone.setPermissions(everyone.permissions.bitfield & ~action.remove, "Hexenbane provisioning");
        break;
      }
      case "create-role": {
        const role = await guild.roles.create({
          name: action.role.name,
          colors: { primaryColor: action.role.color },
          hoist: action.role.hoist,
          mentionable: action.role.mentionable,
          permissions: action.role.permissions,
          reason: "Hexenbane provisioning",
        });
        roleIds.set(action.role.key, role.id);
        break;
      }
      case "role-permissions":
        await guild.roles.edit(action.roleId, { permissions: action.to, reason: "Hexenbane provisioning" });
        break;
      case "order-roles": {
        await guild.roles.fetch();
        const me = await guild.members.fetchMe();
        const roles = action.order
          .map((key) => guild.roles.cache.get(roleIds.get(key) ?? ""))
          .filter((r): r is Role => Boolean(r) && r!.position < me.roles.highest.position);
        // Reuse the positions these roles already hold, so unrelated roles don't move relative to each other.
        const slots = roles.map((r) => r.position).sort((a, b) => b - a);
        const changes = roles.map((role, i) => ({ role: role.id, position: slots[i] })).filter((c, i) => roles[i].position !== c.position);
        if (changes.length) await guild.roles.setPositions(changes);
        break;
      }
      case "create-category": {
        const category = await guild.channels.create({
          name: action.name,
          type: ChannelType.GuildCategory,
          permissionOverwrites: toDiscord(action.overwrites),
          reason: "Hexenbane provisioning",
        });
        categoryIds.set(action.name, category.id);
        break;
      }
      case "category-overwrites":
      case "channel-overwrites":
        await reconcile(action.channelId, action.overwrites);
        break;
      case "create-channel": {
        const parent = categoryIds.get(action.category);
        const base = {
          name: discordChannelName(action.channel.name, action.kind),
          parent,
          permissionOverwrites: toDiscord(action.overwrites),
          reason: "Hexenbane provisioning",
        };
        let created: GuildBasedChannel;
        if (action.kind === "voice") {
          created = await guild.channels.create({ ...base, type: ChannelType.GuildVoice });
        } else if (action.kind === "forum") {
          created = await guild.channels.create({
            ...base,
            type: ChannelType.GuildForum,
            topic: action.channel.topic,
            rateLimitPerUser: action.channel.slowmode,
            availableTags: (action.channel.tags ?? []).slice(0, 20).map((name) => ({ name })),
          });
        } else {
          created = await guild.channels.create({
            ...base,
            type: CHANNEL_TYPES[action.kind],
            topic: action.channel.topic,
            rateLimitPerUser: action.channel.slowmode,
          });
        }
        // Discord copies the category's overwrites onto a channel created with none of its own;
        // clear whatever doesn't belong so a public channel doesn't inherit the category's extras.
        await reconcile(created.id, action.overwrites);
        break;
      }
      case "move-channel": {
        const channel = await guild.channels.fetch(action.channelId);
        const parent = categoryIds.get(action.category);
        if (channel && parent && "setParent" in channel) {
          await channel.setParent(parent, { lockPermissions: false, reason: "Hexenbane provisioning" });
        }
        break;
      }
      case "add-forum-tags": {
        const forum = (await guild.channels.fetch(action.channelId)) as ForumChannel | null;
        if (forum) {
          await forum.setAvailableTags(
            [...forum.availableTags, ...action.tags.map((name) => ({ name }))],
            "Hexenbane provisioning",
          );
        }
        break;
      }
      case "set-topic": {
        const channel = await guild.channels.fetch(action.channelId);
        if (channel && "topic" in channel) await channel.edit({ topic: action.topic, reason: "Hexenbane provisioning" });
        break;
      }
      case "order-channels": {
        const categoryId = categoryIds.get(action.category);
        if (!categoryId) break;
        const fresh = await guild.channels.fetch();
        const inside = [...fresh.values()].filter((c): c is NonNullable<typeof c> => c !== null && c.parentId === categoryId);
        const wanted = action.order.map((n) => n.toLowerCase());
        const managed = inside
          .filter((c) => wanted.includes(c.name.toLowerCase()))
          .sort((a, b) => wanted.indexOf(a.name.toLowerCase()) - wanted.indexOf(b.name.toLowerCase()));
        const slots = managed.map((c) => ("position" in c ? c.position : 0)).sort((a, b) => a - b);
        const changes = managed
          .map((c, i) => ({ channel: c.id, position: slots[i] }))
          .filter((change, i) => ("position" in managed[i] ? managed[i].position : 0) !== change.position);
        if (changes.length) await guild.channels.setPositions(changes);
        break;
      }
    }
    log.ok("done");
  }
}
