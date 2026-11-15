import { Elysia } from "elysia";
import { appUrl, clientId, clientSecret, oauthLifetime, production, redirectUri, sessionLifetime } from "../config";
import { discordJson, exchangeOAuthCode, guildsWithBotStatus, validAccessToken } from "../discord";
import { apiError, redirect } from "../http";
import { cookieValue, expiredSessionCookie, getSession, oauthStates, sessionCookie, sessions } from "../session";
import type { DiscordGuild, Session } from "../types";

export const authRoutes = new Elysia({ name: "auth" })
  .get("/api/auth/status", async ({ headers, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const session = getSession(headers.cookie);
    if (!session) return { authenticated: false, demoAvailable: !production };
    try {
      if (!session.demo) {
        const token = await validAccessToken(session);
        if (!token) return apiError("Discord login expired. Sign in again.", 401);
        session.guilds = await discordJson<DiscordGuild[]>("/users/@me/guilds", token, "Bearer");
      }
      return {
        authenticated: true,
        demo: Boolean(session.demo),
        user: session.user,
        guilds: await guildsWithBotStatus(session, true),
      };
    } catch {
      return apiError("Could not refresh your servers. Try again.", 502);
    }
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
    const session = getSession(headers.cookie);
    const invite = session?.botInvite;
    if (session && invite && state === invite.state) {
      delete session.botInvite;
      if (!query.code || query.error || Date.now() - invite.issuedAt > oauthLifetime) {
        return redirect(`${appUrl}/?invite_error=authorization`);
      }
      try {
        await exchangeOAuthCode(query.code);
        delete session.botStatus;
        delete session.botStatusCheckedAt;
        return redirect(appUrl);
      } catch {
        return redirect(`${appUrl}/?invite_error=authorization`);
      }
    }
    const issuedAt = oauthStates.get(state);
    oauthStates.delete(state);
    const savedState = cookieValue(headers.cookie, "cordstream_oauth_state");
    if (!query.code || !state || savedState !== state || !issuedAt || Date.now() - issuedAt > oauthLifetime) {
      return redirect(`${appUrl}/?auth_error=state`, expiredSessionCookie());
    }

    try {
      const token = await exchangeOAuthCode(query.code);
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
