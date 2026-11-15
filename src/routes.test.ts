import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Session } from "./types";

const credentials = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"] as const;
const savedCredentials = credentials.map((key) => Bun.env[key]);
for (const key of credentials) Bun.env[key] = `test-${key}`;
const { app } = await import("./app");
const { appUrl, botToken, clientId, discordApi, oauthLifetime, production, redirectUri } = await import("./config");
const { oauthStates, sessions } = await import("./session");
credentials.forEach((key, index) => {
  if (savedCredentials[index] === undefined) delete Bun.env[key];
  else Bun.env[key] = savedCredentials[index];
});

const cookie = "cordstream_session=test-session";

function request(path: string, authenticated = false, method = "GET") {
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: authenticated ? { cookie } : {},
  }));
}

function signIn(overrides: Partial<Session> = {}) {
  sessions.set("test-session", {
    user: { id: "test-user", username: "tester" },
    demo: true,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
}

beforeEach(() => {
  sessions.clear();
  oauthStates.clear();
});

afterEach(() => mock.restore());

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

describe("authentication routes", () => {
  test("reports an anonymous session", async () => {
    const response = await request("/api/auth/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false, demoAvailable: !production });
  });

  test("expires and removes stale sessions", async () => {
    signIn({ expiresAt: Date.now() - 1000 });
    const response = await request("/api/auth/status", true);
    expect((await response.json()).authenticated).toBe(false);
    expect(sessions.has("test-session")).toBe(false);
  });

  test("returns the user and demo guilds", async () => {
    signIn();
    const response = await request("/api/auth/status", true);
    const data = await response.json();
    expect(data.authenticated).toBe(true);
    expect(data.demo).toBe(true);
    expect(data.user.id).toBe("test-user");
    expect(data.guilds.map((guild: { id: string }) => guild.id)).toContain("demo-orbit");
  });

  test("refreshes guilds and bot membership on every visit, including within the cache lifetime", async () => {
    const guilds = [
      { id: "owner", name: "Owned", icon: null, owner: true },
      { id: "admin", name: "Administered", icon: null, permissions: "8" },
      { id: "member", name: "Member", icon: null, permissions: "32" },
    ];
    signIn({
      demo: false,
      accessToken: "user-token",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      guilds: [{ id: "removed", name: "Removed", icon: null, owner: true }],
      botStatus: new Map([["owner", false], ["admin", true]]),
      botStatusCheckedAt: Date.now(),
    });
    let botAdded = true;
    const fetchMock = mockFetch(async (input, options) => {
      const url = String(input);
      if (url === `${discordApi}/users/@me/guilds`) {
        expect(options?.headers).toEqual({ Authorization: "Bearer user-token" });
        return Response.json(guilds);
      }
      expect(options?.headers).toEqual({ Authorization: `Bot ${botToken}` });
      expect([`${discordApi}/guilds/owner`, `${discordApi}/guilds/admin`]).toContain(url);
      return new Response("{}", { status: url.endsWith("/owner") && botAdded ? 200 : 404 });
    });
    const response = await request("/api/auth/status", true);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.guilds.map(({ id, botAdded }: { id: string; botAdded: boolean }) => ({ id, botAdded })))
      .toEqual([{ id: "owner", botAdded: true }, { id: "admin", botAdded: false }]);
    botAdded = false;
    guilds[1].permissions = "32";
    const next = await (await request("/api/auth/status", true)).json();
    expect(next.guilds.map(({ id, botAdded }: { id: string; botAdded: boolean }) => ({ id, botAdded })))
      .toEqual([{ id: "owner", botAdded: false }]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test("refreshes an expired access token before loading guilds", async () => {
    signIn({ demo: false, accessToken: "expired", refreshToken: "refresh-token", accessTokenExpiresAt: 0 });
    const fetchMock = mockFetch(async (input, options) => {
      if (String(input) === `${discordApi}/oauth2/token`) {
        const body = options?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-token");
        return Response.json({ access_token: "fresh-token", refresh_token: "rotated-token", expires_in: 3600 });
      }
      expect(String(input)).toBe(`${discordApi}/users/@me/guilds`);
      expect(options?.headers).toEqual({ Authorization: "Bearer fresh-token" });
      return Response.json([]);
    });
    expect((await request("/api/auth/status", true)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessions.get("test-session")?.refreshToken).toBe("rotated-token");
  });

  test("keeps the session when Discord cannot refresh the server list", async () => {
    signIn({ demo: false, accessToken: "user-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    expect((await request("/api/auth/status", true)).status).toBe(502);
    expect(sessions.has("test-session")).toBe(true);
  });

  test("rejects invalid OAuth state and consumes it", async () => {
    oauthStates.set("test-state", Date.now());
    const response = await request("/api/auth/callback?state=test-state&code=test-code");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${appUrl}/?auth_error=state`);
    expect(oauthStates.has("test-state")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("logs out and expires the cookie", async () => {
    signIn();
    const response = await request("/api/auth/logout", true, "POST");
    expect(await response.json()).toEqual({ ok: true });
    expect(sessions.has("test-session")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("guild routes", () => {
  test.each(["channels", "invite"])("protects the %s endpoint", async (endpoint) => {
    const response = await request(`/api/guilds/demo-orbit/${endpoint}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not signed in." });
  });

  test("loads demo channels and roles", async () => {
    signIn();
    const response = await request("/api/guilds/demo-orbit/channels", true);
    const data = await response.json();
    expect(data.botAdded).toBe(true);
    expect(data.channels).toContainEqual({ id: "category-start", name: "START HERE", type: 4, position: 0 });
    expect(data.roles.map((role: { name: string }) => role.name)).toEqual(["Admin", "Streamer"]);
  });

  test("keeps demo channel IDs and parent IDs specific to their guild", async () => {
    signIn();
    const response = await request("/api/guilds/demo-harbor/channels", true);
    const data = await response.json();
    const welcome = data.channels.find((channel: { name: string }) => channel.name === "welcome");
    expect(welcome.id).toBe("harbor-welcome");
    expect(welcome.parent_id).toBe("harbor-category-start");
    expect(data.roles.map((role: { name: string }) => role.name)).toEqual(["Member"]);
  });

  test("returns no channels for a guild without the bot", async () => {
    signIn();
    const response = await request("/api/guilds/demo-figma/channels", true);
    expect(await response.json()).toEqual({ botAdded: false, channels: [], roles: [] });
  });

  test.each(["channels", "invite"])("rejects unknown guilds for %s", async (endpoint) => {
    signIn();
    expect((await request(`/api/guilds/unknown/${endpoint}`, true)).status).toBe(404);
  });

  test.each(["channels", "invite"])("rejects non-administered guilds for %s", async (endpoint) => {
    signIn({ demo: false, guilds: [{ id: "member", name: "Member", icon: null, permissions: "32" }] });
    expect((await request(`/api/guilds/member/${endpoint}`, true)).status).toBe(404);
  });

  test("does not generate a real invite for a demo guild", async () => {
    signIn();
    const response = await request("/api/guilds/demo-figma/invite", true);
    expect(await response.json()).toEqual({ url: null });
  });

  function signInForInvite() {
    signIn({
      demo: false,
      accessToken: "existing-user-token",
      guilds: [{ id: "admin", name: "Administered", icon: null, permissions: "8" }],
      botStatus: new Map([["admin", false]]),
      botStatusCheckedAt: Date.now(),
    });
  }

  test("preselects the server and returns to the app after bot authorization", async () => {
    signInForInvite();
    const result = await (await request("/api/guilds/admin/invite", true)).json();
    const invite = new URL(result.url);
    expect(invite.origin + invite.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(invite.searchParams.get("client_id")).toBe(clientId!);
    expect(invite.searchParams.get("guild_id")).toBe("admin");
    expect(invite.searchParams.get("scope")).toBe("bot applications.commands");
    expect(invite.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(invite.searchParams.get("response_type")).toBe("code");
    const state = invite.searchParams.get("state")!;
    expect(state).toBe(sessions.get("test-session")!.botInvite!.state);
    const fetchMock = mockFetch(async (input, options) => {
      expect(String(input)).toBe(`${discordApi}/oauth2/token`);
      const body = options?.body as URLSearchParams;
      expect(body.get("code")).toBe("invite-code");
      expect(body.get("redirect_uri")).toBe(redirectUri);
      expect(body.get("grant_type")).toBe("authorization_code");
      return Response.json({ access_token: "installation-token", expires_in: 3600 });
    });
    const response = await request(`/api/auth/callback?state=${state}&code=invite-code`, true);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(appUrl);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const session = sessions.get("test-session")!;
    expect(session.accessToken).toBe("existing-user-token");
    expect(session.botStatus).toBeUndefined();
    expect(session.botStatusCheckedAt).toBeUndefined();
    expect(session.botInvite).toBeUndefined();
  });

  test.each(["denied", "expired", "exchange failed"])("returns to the app without logging out when a bot invite is %s", async (failure) => {
    signInForInvite();
    const session = sessions.get("test-session")!;
    session.botInvite = { state: "invite-state", issuedAt: Date.now() - (failure === "expired" ? oauthLifetime + 1 : 0) };
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 400 }));
    const query = failure === "denied" ? "error=access_denied" : "code=invite-code";
    const response = await request(`/api/auth/callback?state=invite-state&${query}`, true);
    expect(response.headers.get("location")).toBe(`${appUrl}/?invite_error=authorization`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(session.botInvite).toBeUndefined();
    expect(sessions.get("test-session")).toBe(session);
    expect(fetchMock).toHaveBeenCalledTimes(failure === "exchange failed" ? 1 : 0);
  });
});

describe("static routes", () => {
  test("serves every imported browser module as JavaScript", async () => {
    const html = await (await request("/")).text();
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    const pending = ["/app.js"];
    const visited = new Set<string>();
    const transpiler = new Bun.Transpiler({ loader: "js" });
    while (pending.length) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      for (const dependency of transpiler.scanImports(await response.text())) {
        pending.push(new URL(dependency.path, `http://localhost${path}`).pathname);
      }
    }
    expect(visited.has("/js/views/navigation.js")).toBe(true);
    expect(visited.has("/js/views/streams.js")).toBe(true);
  });

  test("serves each stylesheet imported by the entry point", async () => {
    const css = await (await request("/styles.css")).text();
    const imports = [...css.matchAll(/@import url\("([^"]+)"\);/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, path] of imports) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/css");
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });

  test.each(["/js/config.ts", "/js/.env", "/styles/config.ts", "/fonts/config.ts"])(
    "rejects unsupported asset paths at %s", async (path) => {
      expect((await request(path)).status).toBe(404);
    },
  );
});
