// Who can see, post in and manage each channel, computed from server-config.ts with Discord's
// permission rules. Printed by `npm run discord -- --matrix` and checked by the tests.

import type { RoleKey, ServerConfig } from "../server-config.ts";
import { bits, channelOverwrites, effectivePermissions, everyoneBase, P, resolveChannel } from "./permissions.ts";

export type Access = "none" | "read" | "write" | "read+moderate" | "write+moderate";

export interface Persona {
  label: string;
  /** Column heading in the printed table. */
  short: string;
  roles: RoleKey[];
}

export const PERSONAS: Persona[] = [
  { label: "Member", short: "Member", roles: [] },
  { label: "Hunter", short: "Hunter", roles: ["hunter"] },
  { label: "Early Supporter", short: "Support", roles: ["earlySupporter", "hunter"] },
  { label: "Playtester", short: "Tester", roles: ["playtester", "hunter"] },
  { label: "Artist", short: "Artist", roles: ["artist", "hunter"] },
  { label: "Composer", short: "Composer", roles: ["composer", "hunter"] },
  { label: "Moderator", short: "Mod", roles: ["moderator", "hunter"] },
  { label: "Playtest Manager", short: "PT Mgr", roles: ["playtestManager", "hunter"] },
  { label: "Developer", short: "Dev", roles: ["developer", "hunter"] },
];

export interface MatrixRow {
  category: string;
  channel: string;
  kind: string;
  access: Record<string, Access>;
}

export function accessMatrix(config: ServerConfig, personas: Persona[] = PERSONAS): MatrixRow[] {
  const base = everyoneBase(config);
  const rows: MatrixRow[] = [];
  for (const category of config.categories) {
    for (const channel of category.channels) {
      const overwrites = channelOverwrites(resolveChannel(category, channel), channel.kind);
      const access: Record<string, Access> = {};
      for (const persona of personas) {
        const roles = persona.roles.map((key) => ({ key, permissions: bits(config.roles.find((r) => r.key === key)!.permissions) }));
        const perms = effectivePermissions(base, roles, overwrites);
        const canSee = (perms & P.ViewChannel) !== 0n;
        const canWrite = channel.kind === "voice" ? (perms & P.Connect) !== 0n : (perms & P.SendMessages) !== 0n;
        const canManage = (perms & P.ManageMessages) !== 0n;
        const moderate = canManage && channel.kind !== "voice";
        access[persona.label] = !canSee ? "none" : canWrite ? (moderate ? "write+moderate" : "write") : moderate ? "read+moderate" : "read";
      }
      rows.push({ category: category.name, channel: channel.kind === "voice" ? channel.name : `#${channel.name}`, kind: channel.kind, access });
    }
  }
  return rows;
}

export function printMatrix(config: ServerConfig): void {
  const rows = accessMatrix(config);
  const symbol: Record<Access, string> = { none: "  ·", read: "  R", write: "  W", "read+moderate": "  R+mod", "write+moderate": "  W+mod" };
  const short = PERSONAS.map((p) => p.short.padEnd(9));
  console.log("· hidden   R read only   W read and write (voice: join and speak)   +mod can delete messages and manage threads\n");
  console.log("".padEnd(28) + short.join(" "));
  let lastCategory = "";
  for (const row of rows) {
    if (row.category !== lastCategory) {
      console.log(`\n${row.category}`);
      lastCategory = row.category;
    }
    console.log("  " + row.channel.padEnd(26) + PERSONAS.map((p) => symbol[row.access[p.label]].padEnd(9)).join(" "));
  }
  console.log("");
}
