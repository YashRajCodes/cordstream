import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Session } from "../src/types";

const credentials = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"] as const;
const savedCredentials = credentials.map((key) => Bun.env[key]);
for (const key of credentials) Bun.env[key] = `test-${key}`;
const savedDatabasePath = Bun.env.STREAM_DATABASE_PATH;
Bun.env.STREAM_DATABASE_PATH = ":memory:";
const { app } = await import("../src/app");
const { appUrl, botToken, clientId, discordApi, oauthLifetime, permissionCacheLifetime, production, redirectUri } = await import("../src/config");
const { oauthStates, sessions } = await import("../src/session");
const { streamStore } = await import("../src/stream-store");
if (savedDatabasePath === undefined) delete Bun.env.STREAM_DATABASE_PATH;
else Bun.env.STREAM_DATABASE_PATH = savedDatabasePath;
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
    guildsCheckedAt: Date.now(),
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
    expect(invite.searchParams.get("permissions")).toBe("66560");
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

describe("stream URL management", () => {
  const endpoint = "/api/guilds/demo-orbit/channels/general/streams";

  test.each(["GET", "POST", "DELETE"])("requires sign-in for %s", async (method) => {
    const path = method === "DELETE" ? `${endpoint}/a-key` : endpoint;
    expect((await request(path, false, method)).status).toBe(401);
  });

  test("creates real public URLs, lists them, and revokes them", async () => {
    signIn();
    const response = await request(endpoint, true, "POST");
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { stream } = await response.json();
    const url = new URL(stream.url);
    expect(url.origin).toBe(new URL(appUrl).origin);
    expect(url.pathname).toBe("/stream/demo-orbit/general");
    expect(url.searchParams.get("key")).toBe(stream.key);
    expect(stream.createdAt).toBeGreaterThan(0);
    expect(stream.ownerId).toBeUndefined();
    expect(streamStore.find(stream.key, "demo-orbit", "general")?.demo).toBe(true);
    const listed = await (await request(endpoint, true)).json();
    expect(listed.streams).toContainEqual(stream);

    const deleted = await request(`${endpoint}/${stream.key}`, true, "DELETE");
    expect(deleted.status).toBe(204);
    expect(streamStore.find(stream.key, "demo-orbit", "general")).toBeUndefined();
    expect((await request(`${endpoint}/${stream.key}`, true, "DELETE")).status).toBe(404);
    expect((await (await request(endpoint, true)).json()).streams).not.toContainEqual(stream);
  });

  test("serves the generated URL without a login and closes its active stream on deletion", async () => {
    signIn();
    const { stream } = await (await request(endpoint, true, "POST")).json();
    const url = new URL(stream.url);
    const response = await request(url.pathname + url.search);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    try {
      while (!frames.includes("event: snapshot\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Expected the public stream's initial snapshot");
        frames += decoder.decode(chunk.value);
      }
      expect(frames).toContain('"demo":true');
      expect(frames).toContain('"author":');
      expect((await request(`/stream/demo-orbit/ideas?key=${stream.key}`)).status).toBe(404);
      expect((await request(`${endpoint}/${stream.key}`, true, "DELETE")).status).toBe(204);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        frames += decoder.decode(chunk.value);
      }
      expect(frames).toContain("event: stream_deleted\n");
      const revoked = await request(url.pathname + url.search);
      expect(revoked.status).toBe(404);
      expect(revoked.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await reader.cancel();
    }
  });

  test("keeps links scoped to their creator, guild, and channel", async () => {
    signIn();
    const { stream } = await (await request(endpoint, true, "POST")).json();
    expect((await request(`/api/guilds/demo-orbit/channels/ideas/streams/${stream.key}`, true, "DELETE")).status).toBe(404);
    expect((await request(`/api/guilds/demo-harbor/channels/harbor-general/streams/${stream.key}`, true, "DELETE")).status).toBe(404);
    signIn({ user: { id: "another-admin", username: "another" } });
    expect((await (await request(endpoint, true)).json()).streams).toEqual([]);
    expect((await request(`${endpoint}/${stream.key}`, true, "DELETE")).status).toBe(404);
    signIn();
    expect((await request(`${endpoint}/${stream.key}`, true, "DELETE")).status).toBe(204);
  });

  test.each(["GET", "POST", "DELETE"])("rejects a non-admin's %s request", async (method) => {
    signIn({ demo: false, guilds: [{ id: "member", name: "Member", icon: null, permissions: "32" }] });
    const path = `/api/guilds/member/channels/channel/streams${method === "DELETE" ? "/a-key" : ""}`;
    expect((await request(path, true, method)).status).toBe(404);
  });

  test.each([
    ["demo-orbit", "missing", 404],
    ["demo-orbit", "category-start", 400],
    ["demo-figma", "general", 409],
    ["unknown", "general", 404],
  ])("rejects an unavailable channel %s/%s", async (guildId, channelId, status) => {
    signIn();
    const response = await request(`/api/guilds/${guildId}/channels/${channelId}/streams`, true, "POST");
    expect(response.status).toBe(status);
  });

  test("checks the real channel's guild and bot history access before creating a link", async () => {
    signIn({ demo: false, guilds: [{ id: "admin", name: "Administered", icon: null, permissions: "8" }] });
    const fetchMock = mockFetch(async (input, options) => {
      expect(options?.headers).toEqual({ Authorization: `Bot ${botToken}` });
      if (String(input) === `${discordApi}/channels/text`) {
        return Response.json({ id: "text", guild_id: "admin", name: "general", type: 0 });
      }
      expect(String(input)).toBe(`${discordApi}/channels/text/messages?limit=1`);
      return Response.json([]);
    });
    const path = "/api/guilds/admin/channels/text/streams";
    const response = await request(path, true, "POST");
    expect(response.status).toBe(201);
    const { stream } = await response.json();
    expect(streamStore.find(stream.key, "admin", "text")?.demo).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await request(`${path}/${stream.key}`, true, "DELETE")).status).toBe(204);
  });

  test("cannot publish a channel from another guild", async () => {
    signIn({ demo: false, guilds: [{ id: "admin", name: "Administered", icon: null, owner: true }] });
    mockFetch(async () => Response.json({ id: "text", guild_id: "another-guild", type: 0 }));
    expect((await request("/api/guilds/admin/channels/text/streams", true, "POST")).status).toBe(404);
  });

  test("does not create a link when Discord refuses history", async () => {
    signIn({ demo: false, guilds: [{ id: "admin", name: "Administered", icon: null, owner: true }] });
    mockFetch(async (input) => String(input).endsWith("/messages?limit=1")
      ? new Response(null, { status: 403 })
      : Response.json({ id: "blocked", guild_id: "admin", type: 0 }));
    expect((await request("/api/guilds/admin/channels/blocked/streams", true, "POST")).status).toBe(502);
    expect(streamStore.list("test-user", "admin", "blocked")).toEqual([]);
  });
});

describe("guild permission freshness", () => {
  const actions = [
    ["/api/guilds/admin/channels", "GET"],
    ["/api/guilds/admin/invite", "GET"],
    ["/api/guilds/admin/channels/text/streams", "GET"],
    ["/api/guilds/admin/channels/text/streams", "POST"],
    ["/api/guilds/admin/channels/text/streams/a-key", "DELETE"],
  ] as const;

  function signInWithOldPermissions(overrides: Partial<Session> = {}) {
    signIn({
      demo: false,
      accessToken: "user-token",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      guilds: [{ id: "admin", name: "Administered", icon: null, permissions: "8" }],
      guildsCheckedAt: Date.now() - permissionCacheLifetime,
      ...overrides,
    });
  }

  test.each(actions)("rechecks expired permissions before %s %s and rejects lost admin access", async (path, method) => {
    signInWithOldPermissions();
    const fetchMock = mockFetch(async (input, options) => {
      expect(String(input)).toBe(`${discordApi}/users/@me/guilds`);
      expect(options?.headers).toEqual({ Authorization: "Bearer user-token" });
      return Response.json([{ id: "admin", name: "Administered", icon: null, permissions: "32" }]);
    });
    expect((await request(path, true, method)).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessions.get("test-session")!.guilds![0].permissions).toBe("32");
  });

  test("reuses permissions for less than one minute and refreshes them on the next action after expiry", async () => {
    signInWithOldPermissions({ guildsCheckedAt: Date.now() });
    const fetchMock = mockFetch(async () => Response.json([]));
    const path = "/api/guilds/admin/channels/text/streams";
    expect((await request(path, true)).status).toBe(200);
    expect((await request(path, true)).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    sessions.get("test-session")!.guildsCheckedAt = Date.now() - permissionCacheLifetime;
    expect((await request(path, true)).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refreshes un-timestamped session permissions and allows newly granted admin access", async () => {
    signInWithOldPermissions({ guilds: [], guildsCheckedAt: undefined });
    mockFetch(async () => Response.json([{ id: "admin", name: "Administered", icon: null, owner: true }]));
    expect((await request("/api/guilds/admin/channels/text/streams", true)).status).toBe(200);
    expect(sessions.get("test-session")!.guildsCheckedAt).toBeGreaterThan(0);
  });

  test("shares an in-flight refresh across simultaneous actions", async () => {
    signInWithOldPermissions();
    let resolveResponse!: (response: Response) => void;
    let notifyStarted!: () => void;
    const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const fetchMock = mockFetch(async () => { notifyStarted(); return pending; });
    const responses = Promise.all(actions.map(([path, method]) => request(path, true, method)));
    await started;
    resolveResponse(Response.json([]));
    expect((await responses).map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refuses mutations if expired permissions cannot be refreshed and retries on the next action", async () => {
    signInWithOldPermissions();
    const stream = streamStore.create({ guildId: "admin", channelId: "text", ownerId: "test-user", demo: false });
    const fetchMock = mockFetch(async () => new Response(null, { status: 503 }));
    const path = `/api/guilds/admin/channels/text/streams/${stream.key}`;
    try {
      expect((await request(path, true, "DELETE")).status).toBe(502);
      expect((await request(path, true, "DELETE")).status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(streamStore.find(stream.key, "admin", "text")).toBeDefined();
    } finally {
      streamStore.delete(stream.key, "test-user", "admin", "text");
    }
  });

  test("requires a new login if expired permissions have no usable OAuth token", async () => {
    signInWithOldPermissions({ accessToken: undefined });
    expect((await request("/api/guilds/admin/invite", true)).status).toBe(401);
  });

  test("also expires cached bot membership after one minute", async () => {
    signInWithOldPermissions({
      guildsCheckedAt: Date.now(), botStatus: new Map([["admin", true]]),
      botStatusCheckedAt: Date.now() - permissionCacheLifetime,
    });
    const fetchMock = mockFetch(async (input, options) => {
      expect(String(input)).toBe(`${discordApi}/guilds/admin`);
      expect(options?.headers).toEqual({ Authorization: `Bot ${botToken}` });
      return new Response(null, { status: 404 });
    });
    expect(await (await request("/api/guilds/admin/channels", true)).json()).toEqual({ botAdded: false, channels: [], roles: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
