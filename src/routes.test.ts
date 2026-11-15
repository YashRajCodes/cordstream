import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "./app";
import { appUrl, production } from "./config";
import { oauthStates, sessions } from "./session";
import type { Session } from "./types";

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

  test("only returns administered guilds and retains cached bot status", async () => {
    signIn({
      demo: false,
      guilds: [
        { id: "owner", name: "Owned", icon: null, owner: true },
        { id: "admin", name: "Administered", icon: null, permissions: "8" },
        { id: "member", name: "Member", icon: null, permissions: "32" },
      ],
      botStatus: new Map([["owner", true], ["admin", false]]),
      botStatusCheckedAt: Date.now(),
    });
    const response = await request("/api/auth/status", true);
    const data = await response.json();
    expect(data.guilds.map(({ id, botAdded }: { id: string; botAdded: boolean }) => ({ id, botAdded })))
      .toEqual([{ id: "owner", botAdded: true }, { id: "admin", botAdded: false }]);
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
