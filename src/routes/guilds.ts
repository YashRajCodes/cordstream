import { Elysia } from "elysia";
import { botToken, clientId } from "../config";
import { demoChannelsFor, demoGuilds, demoRoles } from "../demo";
import { discordJson, guildsWithBotStatus, validAccessToken } from "../discord";
import { apiError } from "../http";
import { hasAdministratorPermission, namesForPermissions } from "../permissions";
import { getSession } from "../session";
import type { DiscordChannel } from "../types";

export const guildRoutes = new Elysia({ name: "guilds" })
  .get("/api/guilds/:id/channels", async ({ params, headers }) => {
    const session = getSession(headers.cookie);
    if (!session) return apiError("Not signed in.", 401);
    if (session.demo) {
      const guild = demoGuilds.find((item) => item.id === params.id);
      if (!guild) return apiError("Server not found.", 404);
      if (!guild.botAdded) return { botAdded: false, channels: [], roles: [] };
      return {
        botAdded: true,
        channels: demoChannelsFor(guild.id),
        roles: guild.id === "demo-orbit" ? demoRoles.slice(0, 2) : [demoRoles[2]],
      };
    }

    const guild = session.guilds?.find((item) => item.id === params.id && hasAdministratorPermission(item));
    if (!guild) return apiError("Server not found.", 404);
    const guildStatus = await guildsWithBotStatus(session);
    const available = guildStatus.find((item) => item.id === params.id)?.botAdded ?? false;
    if (!available || !botToken) return { botAdded: false, channels: [], roles: [] };

    try {
      const accessToken = await validAccessToken(session);
      const [channels, member, guildRoles] = await Promise.all([
        discordJson<DiscordChannel[]>(`/guilds/${guild.id}/channels`, botToken),
        accessToken
          ? discordJson<{ roles: string[] }>(`/users/@me/guilds/${guild.id}/member`, accessToken, "Bearer")
          : Promise.reject(new Error("Discord login expired")),
        discordJson<Array<{ id: string; name: string; color: number; permissions: string }>>(`/guilds/${guild.id}/roles`, botToken).catch(() => []),
      ]);
      const roles = member.roles.map((roleId) => {
        const role = guildRoles.find((item) => item.id === roleId);
        if (!role) return { id: roleId, name: "Role", color: 0, permissions: "0", permissionNames: [] };
        return { ...role, permissionNames: namesForPermissions(role.permissions) };
      });
      return { botAdded: true, channels, roles };
    } catch {
      return apiError("Could not load this server.", 502);
    }
  })
  .get("/api/guilds/:id/invite", ({ params, headers }) => {
    const session = getSession(headers.cookie);
    if (!session) return apiError("Not signed in.", 401);
    const isDemo = session.demo && demoGuilds.some((guild) => guild.id === params.id);
    const isMember = session.guilds?.some((guild) => guild.id === params.id && hasAdministratorPermission(guild));
    if (!isDemo && !isMember) return apiError("Server not found.", 404);
    if (!clientId || session.demo) return { url: null };
    const invite = new URL("https://discord.com/oauth2/authorize");
    invite.search = new URLSearchParams({
      client_id: clientId,
      scope: "bot applications.commands",
      permissions: "1024",
      guild_id: params.id,
      disable_guild_select: "false",
    }).toString();
    return { url: invite.toString() };
  });
