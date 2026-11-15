import { botToken, clientId, clientSecret, discordApi, permissionCacheLifetime, redirectUri } from "./config";
import { demoGuilds } from "./demo";
import { hasAdministratorPermission } from "./permissions";
import type { DiscordGuild, Guild, Session } from "./types";

export async function exchangeOAuthCode(code: string) {
  const response = await fetch(`${discordApi}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error("OAuth token exchange failed");
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

export async function discordJson<T>(path: string, token: string, kind: "Bot" | "Bearer" = "Bot"): Promise<T> {
  const response = await fetch(`${discordApi}${path}`, {
    headers: { Authorization: `${kind} ${token}` },
    signal: AbortSignal.timeout(15_000),
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

const permissionRequests = new WeakMap<Session, Promise<DiscordGuild[] | undefined>>();

/** Recheck each action, but share a successful Discord permission result for at most one minute. */
export async function refreshGuildPermissions(session: Session, force = false): Promise<DiscordGuild[] | undefined> {
  const age = Date.now() - (session.guildsCheckedAt ?? 0);
  if (!force && session.guilds && session.guildsCheckedAt !== undefined && age >= 0 && age < permissionCacheLifetime) {
    return session.guilds;
  }
  const pending = permissionRequests.get(session);
  if (pending) return pending;
  const request = (async () => {
    const token = await validAccessToken(session);
    if (!token) return undefined;
    const guilds = await discordJson<DiscordGuild[]>("/users/@me/guilds", token, "Bearer");
    session.guilds = guilds;
    session.guildsCheckedAt = Date.now();
    return guilds;
  })();
  permissionRequests.set(session, request);
  try {
    return await request;
  } finally {
    permissionRequests.delete(session);
  }
}

export async function guildsWithBotStatus(session: Session, refresh = false): Promise<Guild[]> {
  if (session.demo) return demoGuilds;
  const guilds = (session.guilds ?? []).filter(hasAdministratorPermission);
  const cached = session.botStatus;
  const checkedAt = Date.now();
  const age = checkedAt - (session.botStatusCheckedAt ?? 0);
  if (!refresh && cached && age >= 0 && age < permissionCacheLifetime) {
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
  session.botStatusCheckedAt = checkedAt;
  return guilds.map((guild) => ({ ...guild, botAdded: status.get(guild.id) ?? false }));
}
