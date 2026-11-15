import { Elysia } from "elysia";
import { appUrl, clientId, clientSecret, discordApi, oauthLifetime, production, redirectUri, sessionLifetime } from "../config";
import { discordJson, guildsWithBotStatus } from "../discord";
import { apiError, redirect } from "../http";
import { cookieValue, expiredSessionCookie, getSession, oauthStates, sessionCookie, sessions } from "../session";
import type { DiscordGuild, Session } from "../types";

export const authRoutes = new Elysia({ name: "auth" })
  .get("/api/auth/status", async ({ headers }) => {
    const session = getSession(headers.cookie);
    if (!session) return { authenticated: false, demoAvailable: !production };
    return {
      authenticated: true,
      demo: Boolean(session.demo),
      user: session.user,
      guilds: await guildsWithBotStatus(session),
    };
  })
  .get("/api/auth/login", ({ headers }) => {
    if (!clientId || !clientSecret) {
      if (production) return apiError("Discord login is not configured.", 503);
      const id = crypto.randomUUID();
      sessions.set(id, {
        user: { id: "demo-user", username: "you", global_name: "You" },
        demo: true,
        expiresAt: Date.now() + sessionLifetime * 1000,
      });
      return redirect(appUrl, sessionCookie(id));
    }

    const state = crypto.randomUUID();
    oauthStates.set(state, Date.now());
    const cookieState = cookieValue(headers.cookie, "cordstream_oauth_state");
    if (cookieState) oauthStates.delete(cookieState);
    const stateCookie = `cordstream_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${production ? "; Secure" : ""}`;
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify guilds guilds.members.read",
      state,
    }).toString();
    return redirect(authorize.toString(), stateCookie);
  })
  .get("/api/auth/callback", async ({ query, headers }) => {
    const state = typeof query.state === "string" ? query.state : "";
    const issuedAt = oauthStates.get(state);
    oauthStates.delete(state);
    const savedState = cookieValue(headers.cookie, "cordstream_oauth_state");
    if (!query.code || !state || savedState !== state || !issuedAt || Date.now() - issuedAt > oauthLifetime) {
      return redirect(`${appUrl}/?auth_error=state`, expiredSessionCookie());
    }

    try {
      const tokenResponse = await fetch(`${discordApi}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          grant_type: "authorization_code",
          code: query.code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenResponse.ok) throw new Error("OAuth token exchange failed");
      const token = await tokenResponse.json() as { access_token: string; refresh_token?: string; expires_in: number };
      const [user, guilds] = await Promise.all([
        discordJson<Session["user"]>("/users/@me", token.access_token, "Bearer"),
        discordJson<DiscordGuild[]>("/users/@me/guilds", token.access_token, "Bearer"),
      ]);
      const id = crypto.randomUUID();
      sessions.set(id, {
        user,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
        guilds,
        expiresAt: Date.now() + sessionLifetime * 1000,
      });
      const stateCookie = `cordstream_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production ? "; Secure" : ""}`;
      const response = redirect(appUrl, sessionCookie(id));
      response.headers.append("Set-Cookie", stateCookie);
      return response;
    } catch {
      return redirect(`${appUrl}/?auth_error=oauth`, expiredSessionCookie());
    }
  })
  .post("/api/auth/logout", ({ headers }) => {
    const id = cookieValue(headers.cookie, "cordstream_session");
    if (id) sessions.delete(id);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": expiredSessionCookie() },
    });
  });
