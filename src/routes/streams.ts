import { Elysia } from "elysia";
import { requireGuildAccess } from "../access";
import { botToken } from "../config";
import { demoChannelsFor, demoGuilds } from "../demo";
import { discordJson } from "../discord";
import { apiError } from "../http";
import { publicStream, streamStore } from "../stream-store";
import type { DiscordChannel } from "../types";

const messageChannelTypes = new Set([0, 2, 5, 10, 11, 12, 13]);

export const streamManagementRoutes = new Elysia({ name: "stream-management" })
  .get("/api/guilds/:guildId/channels/:channelId/streams", async ({ params, headers, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const session = await requireGuildAccess(headers.cookie, params.guildId);
    if (session instanceof Response) return session;
    return {
      streams: streamStore.list(session.user.id, params.guildId, params.channelId, Boolean(session.demo)).map(publicStream),
    };
  })
  .post("/api/guilds/:guildId/channels/:channelId/streams", async ({ params, headers, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const session = await requireGuildAccess(headers.cookie, params.guildId);
    if (session instanceof Response) return session;

    if (session.demo) {
      const guild = demoGuilds.find((item) => item.id === params.guildId)!;
      if (!guild.botAdded) return apiError("Add the bot to this server first.", 409);
      const channel = demoChannelsFor(guild.id).find((item) => item.id === params.channelId);
      if (!channel) return apiError("Channel not found.", 404);
      if (!messageChannelTypes.has(channel.type)) return apiError("Choose a channel that supports messages.", 400);
    } else {
      if (!botToken) return apiError("Discord bot is not configured.", 503);
      try {
        const channel = await discordJson<DiscordChannel & { guild_id: string }>(`/channels/${encodeURIComponent(params.channelId)}`, botToken);
        if (channel.id !== params.channelId || channel.guild_id !== params.guildId) return apiError("Channel not found in this server.", 404);
        if (!messageChannelTypes.has(channel.type)) return apiError("Choose a channel that supports messages.", 400);
        // Check the same endpoint used by the public stream before issuing a link.
        await discordJson<unknown[]>(`/channels/${encodeURIComponent(channel.id)}/messages?limit=1`, botToken);
      } catch {
        return apiError("Could not read this channel. Check the bot's View Channel and Read Message History permissions.", 502);
      }
    }

    const stream = streamStore.create({
      guildId: params.guildId,
      channelId: params.channelId,
      ownerId: session.user.id,
      demo: Boolean(session.demo),
    });
    set.status = 201;
    return { stream: publicStream(stream) };
  })
  .delete("/api/guilds/:guildId/channels/:channelId/streams/:key", async ({ params, headers, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const session = await requireGuildAccess(headers.cookie, params.guildId);
    if (session instanceof Response) return session;
    const deleted = streamStore.delete(params.key, session.user.id, params.guildId, params.channelId, Boolean(session.demo));
    if (!deleted) return apiError("Stream URL not found.", 404);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
