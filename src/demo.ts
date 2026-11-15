import type { DiscordChannel, Guild, Role } from "./types";

export const demoGuilds: Guild[] = [
  { id: "demo-orbit", name: "Orbit Studio", icon: null, botAdded: true },
  { id: "demo-harbor", name: "Harbor Devs", icon: null, botAdded: true },
  { id: "demo-figma", name: "Figma Community", icon: null, botAdded: false },
  { id: "demo-makers", name: "Makers Club", icon: null, botAdded: false },
];

const demoChannels: DiscordChannel[] = [
  { id: "category-start", name: "START HERE", type: 4, position: 0 },
  { id: "welcome", name: "welcome", type: 0, position: 0, parent_id: "category-start" },
  { id: "announcements", name: "announcements", type: 5, position: 1, parent_id: "category-start" },
  { id: "category-community", name: "COMMUNITY", type: 4, position: 1 },
  { id: "general", name: "general", type: 0, position: 0, parent_id: "category-community" },
  { id: "build-log", name: "build-log", type: 0, position: 1, parent_id: "category-community" },
  { id: "ideas", name: "ideas", type: 0, position: 2, parent_id: "category-community" },
  { id: "voice", name: "The lounge", type: 2, position: 3, parent_id: "category-community" },
  { id: "category-team", name: "TEAM", type: 4, position: 2 },
  { id: "releases", name: "releases", type: 0, position: 0, parent_id: "category-team" },
  { id: "category-empty", name: "UNCATEGORIZED", type: 4, position: 3 },
];

export const demoRoles: Role[] = [
  { id: "role-admin", name: "Admin", color: 0x4bce97, permissions: "8", permissionNames: ["Administrator"] },
  { id: "role-streamer", name: "Streamer", color: 0x7f77dd, permissions: "3072", permissionNames: ["View Channels", "Send Messages"] },
  { id: "role-member", name: "Member", color: 0, permissions: "3072", permissionNames: ["View Channels", "Send Messages"] },
];

export function demoChannelsFor(guildId: string) {
  if (guildId === "demo-harbor") {
    return demoChannels.map((channel) => ({
      ...channel,
      id: `harbor-${channel.id}`,
      parent_id: channel.parent_id ? `harbor-${channel.parent_id}` : undefined,
    }));
  }
  return demoChannels;
}
