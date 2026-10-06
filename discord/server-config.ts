// ─────────────────────────────────────────────────────────────────────────────
//  HEXENBANE DISCORD SERVER LAYOUT
// ─────────────────────────────────────────────────────────────────────────────
//  The provisioning script (npm run discord) makes the server match this file.
//  It only ever ADDS roles, categories, channels and forum tags, and adjusts
//  permissions on the roles and channels named here. It never deletes or
//  renames anything, and leaves channels and roles not named here alone.
//
//  Edit this file, run `npm run discord` to preview, then
//  `npm run discord -- --apply` to make the changes.
//
//  Who can see a channel is set by `view`; who can write in it by `post`.
//  A channel inherits its category's `view` and `manage` unless it sets its own.
//  `post` defaults to everyone who can view it.
// ─────────────────────────────────────────────────────────────────────────────

import type { PermissionFlagsBits } from "discord.js";

export type PermissionName = keyof typeof PermissionFlagsBits;

export type RoleKey =
  | "developer"
  | "playtestManager"
  | "moderator"
  | "artist"
  | "composer"
  | "playtester"
  | "earlySupporter"
  | "hunter";

/** "everyone" is the @everyone role: every member of the server. */
export type Audience = "everyone" | RoleKey;

export type ChannelKind = "text" | "announcement" | "forum" | "voice";

export interface RoleConfig {
  key: RoleKey;
  name: string;
  color: number;
  /** Show members with this role separately in the member list. */
  hoist: boolean;
  /** Whether anyone can @mention this role. */
  mentionable: boolean;
  /** Server-wide permissions on top of what @everyone has. Keep these minimal. */
  permissions: PermissionName[];
}

export interface ChannelConfig {
  name: string;
  kind: ChannelKind;
  topic?: string;
  view?: Audience[];
  /** Who may send messages (or create forum posts). Omit for "everyone who can view". */
  post?: Audience[];
  /** Roles that may delete messages and manage threads/posts here. */
  manage?: RoleKey[];
  /** Forum tags (max 20). */
  tags?: string[];
  /** Seconds between messages per member (0 = off). */
  slowmode?: number;
}

export interface CategoryConfig {
  name: string;
  view: Audience[];
  manage?: RoleKey[];
  channels: ChannelConfig[];
}

export interface ServerConfig {
  /** Roles from highest to lowest. The script keeps them in this order (below its own role). */
  roles: RoleConfig[];
  /** Permissions taken away from @everyone server-wide. */
  everyoneRemove: PermissionName[];
  categories: CategoryConfig[];
}

// Audiences, defined once so every category stays consistent.
const PUBLIC: Audience[] = ["everyone"];
const STAFF_POSTERS: Audience[] = ["developer"];
const PLAYTEST_STAFF: RoleKey[] = ["developer", "playtestManager"];
const PLAYTEST_AUDIENCE: Audience[] = ["playtester", "developer", "playtestManager", "moderator"];
const OPERATIONS: Audience[] = ["developer", "playtestManager"];
const INTERNAL: Audience[] = ["developer", "artist", "composer"];

export const serverConfig: ServerConfig = {
  roles: [
    {
      key: "developer",
      name: "Developer",
      color: 0xa58bff,
      hoist: true,
      mentionable: false,
      permissions: [
        "ViewAuditLog",
        "ManageMessages",
        "ManageThreads",
        "ManageNicknames",
        "ManageEvents",
        "CreateEvents",
        "ModerateMembers",
        "KickMembers",
        "MentionEveryone",
        "MuteMembers",
        "DeafenMembers",
        "MoveMembers",
        "PrioritySpeaker",
      ],
    },
    {
      key: "playtestManager",
      name: "Playtest Manager",
      color: 0x6f8fe8,
      hoist: true,
      mentionable: false,
      // Manage Roles lets them give out the Playtester role (only roles below their own).
      permissions: ["ManageRoles"],
    },
    {
      key: "moderator",
      name: "Moderator",
      color: 0xd4c9ff,
      hoist: true,
      mentionable: false,
      permissions: [
        "ManageMessages",
        "ManageThreads",
        "ManageNicknames",
        "ModerateMembers",
        "KickMembers",
        "BanMembers",
        "ViewAuditLog",
        "MuteMembers",
        "MoveMembers",
      ],
    },
    // Creative collaborators: channel access only, no moderation powers.
    { key: "artist", name: "Artist", color: 0xc98ad9, hoist: false, mentionable: false, permissions: [] },
    { key: "composer", name: "Composer", color: 0x8fb3c9, hoist: false, mentionable: false, permissions: [] },
    { key: "playtester", name: "Playtester", color: 0xb9a8ff, hoist: true, mentionable: false, permissions: [] },
    { key: "earlySupporter", name: "Early Supporter", color: 0xe0c891, hoist: false, mentionable: false, permissions: [] },
    // The thematic community role. Cosmetic: it unlocks nothing @everyone can't already see.
    { key: "hunter", name: "Hunter", color: 0x8c86a6, hoist: false, mentionable: false, permissions: [] },
  ],

  // Members can't ping @everyone/@here or every role by default once this is removed.
  everyoneRemove: ["MentionEveryone"],

  categories: [
    {
      name: "START HERE",
      view: PUBLIC,
      manage: ["developer", "moderator"],
      channels: [
        { name: "welcome", kind: "text", post: STAFF_POSTERS, topic: "Welcome to Hexenbane. Start here." },
        { name: "rules-and-info", kind: "text", post: STAFF_POSTERS, topic: "Server rules and important information." },
        { name: "announcements", kind: "announcement", post: STAFF_POSTERS, topic: "Major Hexenbane announcements." },
        { name: "faq", kind: "text", post: STAFF_POSTERS, topic: "Common questions about Hexenbane and the playtest." },
      ],
    },
    {
      name: "THE CHAPTER HOUSE",
      view: PUBLIC,
      manage: ["developer", "moderator"],
      channels: [
        { name: "general", kind: "text", topic: "Talk about Hexenbane and anything nearby." },
        {
          name: "screenshots-and-clips",
          kind: "text",
          topic: "Hexenbane media, once sharing is allowed. No private playtest footage without permission.",
          slowmode: 10,
        },
        { name: "deckbuilding", kind: "text", topic: "Builds, cards, Implements and strategy." },
        { name: "lore-discussion", kind: "text", topic: "The covens, the Chapterhouse and theories. Unreleased story goes in the playtest spoilers channel." },
        {
          name: "suggestions",
          kind: "forum",
          topic: "One idea per post. Search before posting.",
          tags: ["Gameplay", "Cards", "UI/UX", "Audio", "Lore", "Community"],
          slowmode: 300,
        },
        { name: "off-topic", kind: "text", topic: "Everything else." },
      ],
    },
    {
      name: "DEVELOPMENT",
      view: PUBLIC,
      manage: ["developer", "moderator"],
      channels: [
        { name: "dev-updates", kind: "text", post: STAFF_POSTERS, topic: "Posts from the developer." },
        { name: "patch-notes", kind: "text", post: STAFF_POSTERS, topic: "Patch and update history." },
        { name: "known-issues", kind: "text", post: ["developer", "playtestManager"], topic: "Known public issues." },
      ],
    },
    {
      name: "PLAYTEST OPERATIONS",
      // Hidden from everyone except the people who run the playtest.
      view: OPERATIONS,
      manage: PLAYTEST_STAFF,
      channels: [
        { name: "playtest-applications", kind: "text", topic: "Incoming applications from the playtest website (webhook)." },
        { name: "playtest-admin", kind: "text", topic: "Approvals, rejections and access." },
        { name: "playtest-notes", kind: "text", topic: "Internal notes and observations." },
      ],
    },
    {
      name: "PRIVATE PLAYTEST",
      // Approved testers and staff only.
      view: PLAYTEST_AUDIENCE,
      manage: ["developer", "playtestManager", "moderator"],
      channels: [
        {
          name: "playtest-info",
          kind: "text",
          post: PLAYTEST_STAFF,
          topic: "Current test goals, the confidentiality reminder and how to report problems.",
        },
        {
          name: "build-downloads",
          kind: "text",
          // Testers can read and download; only playtest staff can post builds.
          post: PLAYTEST_STAFF,
          topic: "Current playtest build. Do not share these files or links with anyone.",
        },
        { name: "playtest-announcements", kind: "text", post: PLAYTEST_STAFF, topic: "Announcements for testers." },
        {
          name: "bug-reports",
          kind: "forum",
          topic: "One bug per post: what happened, what you expected, steps to repeat, your build and hardware.",
          tags: ["New", "Confirmed", "Needs Info", "Fixed", "UI", "Combat", "Performance", "Crash"],
        },
        {
          name: "playtest-feedback",
          kind: "forum",
          topic: "One topic per post. Be specific.",
          tags: ["Gameplay", "Balance", "Cards", "UI/UX", "Progression", "Difficulty", "Other"],
        },
        { name: "balance-discussion", kind: "text", topic: "Talk numbers, pairs and difficulty." },
        { name: "spoilers", kind: "text", topic: "Story and content from the playtest build. Never repost outside this server." },
      ],
    },
    {
      name: "INTERNAL DEVELOPMENT",
      // Collaborators only; not visible to Playtesters or the community.
      view: INTERNAL,
      manage: ["developer"],
      channels: [
        { name: "dev-team", kind: "text", topic: "Team discussion." },
        { name: "art-review", kind: "text", topic: "Art for review." },
        { name: "audio-review", kind: "text", topic: "Music and sound for review." },
        { name: "internal-builds", kind: "text", post: ["developer"], topic: "Internal builds. Not for testers." },
        { name: "internal-notes", kind: "text", topic: "Notes and plans." },
      ],
    },
    {
      name: "VOICE",
      view: PUBLIC,
      manage: ["developer", "moderator"],
      channels: [
        { name: "The Chapter House", kind: "voice" },
        { name: "Playtest Session", kind: "voice", view: PLAYTEST_AUDIENCE },
        { name: "Dev Room", kind: "voice", view: INTERNAL },
      ],
    },
  ],
};
