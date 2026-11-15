import { botToken, clientId, clientSecret, discordApi } from "./config";
import { demoGuilds } from "./demo";
import { hasAdministratorPermission } from "./permissions";
import type { Guild, Session } from "./types";

export async function discordJson<T>(path: string, token: string, kind: "Bot" | "Bearer" = "Bot"): Promise<T> {
  const response = await fetch(`${discordApi}${path}`, {
    headers: { Authorization: `${kind} ${token}` },
  });
  if (!response.ok) throw new Error(`Discord API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function validAccessToken(session: Session) {
  if (session.accessToken && (session.accessTokenExpiresAt ?? 0) > Date.now() + 60_000) return session.accessToken;
  if (!session.refreshToken || !clientId || !clientSecret) return undefined;
  try {
    const response = await fetch(`${discordApi}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      }),
    });
    if (!response.ok) return undefined;
    const token = await response.json() as { access_token: string; refresh_token?: string; expires_in: number };
    session.accessToken = token.access_token;
    session.refreshToken = token.refresh_token ?? session.refreshToken;
    session.accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
    return session.accessToken;
  } catch {
    return undefined;
  }
}

export async function guildsWithBotStatus(session: Session): Promise<Guild[]> {
  if (session.demo) return demoGuilds;
  const guilds = (session.guilds ?? []).filter(hasAdministratorPermission);
  const cached = session.botStatus;
  if (cached && Date.now() - (session.botStatusCheckedAt ?? 0) < 60_000) {
    return guilds.map((guild) => ({ ...guild, botAdded: cached.get(guild.id) ?? false }));
  }

  const status = new Map<string, boolean>();
  const token = botToken;
  if (token) {
    for (let i = 0; i < guilds.length; i += 6) {
      const batch = guilds.slice(i, i + 6);
      const results = await Promise.all(batch.map(async (guild) => {
        try {
          await discordJson(`/guilds/${guild.id}`, token);
          return [guild.id, true] as const;
        } catch {
          return [guild.id, false] as const;
        }
      }));
      results.forEach(([id, inGuild]) => status.set(id, inGuild));
    }
  }
  session.botStatus = status;
  session.botStatusCheckedAt = Date.now();
  return guilds.map((guild) => ({ ...guild, botAdded: status.get(guild.id) ?? false }));
}
