import { Elysia } from "elysia";
import { requireGuildAccess } from "../access";
import { botToken, clientId, redirectUri } from "../config";
import { demoChannelsFor, demoGuilds, demoRoles } from "../demo";
import { discordJson, guildsWithBotStatus, validAccessToken } from "../discord";
import { apiError } from "../http";
import { namesForPermissions } from "../permissions";
import type { DiscordChannel } from "../types";

export const guildRoutes = new Elysia({ name: "guilds" })
  .get("/api/guilds/:guildId/channels", async ({ params, headers, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const session = await requireGuildAccess(headers.cookie, params.guildId);
    if (session instanceof Response) return session;
    if (session.demo) {
      const guild = demoGuilds.find((item) => item.id === params.guildId);
      if (!guild) return apiError("Server not found.", 404);
      if (!guild.botAdded) return { botAdded: false, channels: [], roles: [] };
      return {
        botAdded: true,
        channels: demoChannelsFor(guild.id),
        roles: guild.id === "demo-orbit" ? demoRoles.slice(0, 2) : [demoRoles[2]],
      };
    }

    const guild = session.guilds!.find((item) => item.id === params.guildId)!;
    const guildStatus = await guildsWithBotStatus(session);
    const available = guildStatus.find((item) => item.id === params.guildId)?.botAdded ?? false;
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
  .get("/api/guilds/:guildId/invite", async ({ params, headers, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const session = await requireGuildAccess(headers.cookie, params.guildId);
    if (session instanceof Response) return session;
    if (!clientId || session.demo) return { url: null };
    const state = crypto.randomUUID();
    session.botInvite = { state, issuedAt: Date.now() };
    const invite = new URL("https://discord.com/oauth2/authorize");
    invite.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: "bot applications.commands",
      permissions: "66560",
      guild_id: params.guildId,
      disable_guild_select: "false",
    }).toString();
    return { url: invite.toString() };
  });
