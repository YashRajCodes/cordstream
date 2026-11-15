export const discordApi = "https://discord.com/api/v10";
export const port = Number(Bun.env.PORT ?? 3001);
export const appUrl = Bun.env.APP_URL ?? `http://localhost:${port}`;
export const redirectUri = Bun.env.DISCORD_REDIRECT_URI ?? `${appUrl}/api/auth/callback`;
export const clientId = Bun.env.DISCORD_CLIENT_ID;
export const clientSecret = Bun.env.DISCORD_CLIENT_SECRET;
export const botToken = Bun.env.DISCORD_BOT_TOKEN;
export const streamDatabasePath = Bun.env.STREAM_DATABASE_PATH ?? "data/cordstream.sqlite";
export function isPrivateInstance() {
  return Boolean(Bun.env.PRIVATE);
}
export const production = Bun.env.NODE_ENV === "production";
export const sessionLifetime = 7 * 24 * 60 * 60;
export const oauthLifetime = 10 * 60 * 1000;
export const permissionCacheLifetime = 60_000;
