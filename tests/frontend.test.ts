import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const build = await Bun.build({
  entrypoints: [`${import.meta.dir}/../public/app.js`],
  target: "browser",
  format: "iife",
});
if (!build.success) throw new Error(`Browser build failed: ${build.logs.join("\n")}`);
const script = await build.outputs[0].text();

type RequestHandler = (url: string, options?: RequestInit) => Response | Promise<Response> | undefined;

function openApp(botAdded = false, initialRequestHandler?: RequestHandler) {
  const app = Object.assign(new EventTarget(), {
    innerHTML: "",
    querySelector: () => ({ scrollTop: 0, scrollLeft: 0 }),
  });
  const toast = { textContent: "", dataset: {} };
  const window = Object.assign(new EventTarget(), {
    location: { search: "", pathname: "/" },
  });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    querySelector: (selector: string) => selector === "#app" ? app : toast,
  });
  let guilds = [{ id: "server", name: "Server", icon: null, botAdded }];
  let user = { id: "user", username: "tester" };
  let channels = [{ id: "channel", name: "general", type: 0, position: 0 }];
  let streams: Array<{ key: string; url: string; guildId: string; channelId: string; createdAt: number }> = [];
  let requestHandler = initialRequestHandler;
  let status = 200;
  const requests: string[] = [];
  const requestDetails: Array<{ url: string; method: string }> = [];
  runInNewContext(script, {
    window, document, URLSearchParams,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url: string, options?: RequestInit) => {
      requests.push(url);
      requestDetails.push({ url, method: options?.method ?? "GET" });
      const intercepted = requestHandler?.(url, options);
      if (intercepted) return intercepted;
      if (url.endsWith("/streams")) {
        const [, guildId, channelId] = url.match(/^\/api\/guilds\/([^/]+)\/channels\/([^/]+)\/streams$/)!;
        if (options?.method === "POST") {
          const stream = {
            key: "public-key", url: `http://localhost/stream/${guildId}/${channelId}?key=public-key`,
            createdAt: Date.now(), guildId, channelId,
          };
          streams = [...streams, stream];
          return Response.json({ stream });
        }
        return Response.json({ streams: streams.filter((stream) => stream.guildId === guildId && stream.channelId === channelId) });
      }
      if (options?.method === "DELETE") {
        streams = streams.filter((stream) => !url.endsWith(`/${stream.key}`));
        return new Response(null, { status: 204 });
      }
      return url === "/api/auth/status"
        ? Response.json({ authenticated: true, user, guilds }, { status })
        : Response.json({ botAdded: true, channels, roles: [] });
    },
  });
  return {
    app, toast, window, document, requests, requestDetails,
    setGuilds: (next: typeof guilds) => { guilds = next; },
    setUser: (next: typeof user) => { user = next; },
    setChannels: (next: typeof channels) => { channels = next; },
    intercept: (handler: typeof requestHandler) => { requestHandler = handler; },
    setStatus: (next: number) => { status = next; },
    async settle() { await Bun.sleep(0); },
    action(action: string, id?: string, extra: Record<string, string> = {}) {
      const event = new Event("click");
      Object.defineProperty(event, "target", {
        value: { closest: () => ({ dataset: { action, id, ...extra } }) },
      });
      app.dispatchEvent(event);
    },
    selectGuild() { this.action("select-guild", "server"); },
  };
}

describe("loading states", () => {
  test("shows a loading screen until the initial session request finishes", async () => {
    let resolveSession!: (response: Response) => void;
    const page = openApp(false, (url) => url === "/api/auth/status"
      ? new Promise<Response>((resolve) => { resolveSession = resolve; })
      : undefined);
    expect(page.app.innerHTML).toContain('class="loading-screen"');
    expect(page.app.innerHTML).toContain("Loading your servers");
    expect(page.app.innerHTML).toContain('role="status"');
    expect(page.app.innerHTML).not.toContain("Choose a server");
    resolveSession(Response.json({ authenticated: false }));
    await page.settle();
    expect(page.app.innerHTML).toContain("log in with discord");
    expect(page.app.innerHTML).not.toContain('class="loading-screen"');
  });

  test("shows the private instance message after an unauthorized login", async () => {
    const page = openApp(false, (url) => url === "/api/auth/status"
      ? Response.json({ authenticated: false })
      : undefined);
    page.window.location.search = "?auth_error=private";
    await page.settle();
    expect(page.app.innerHTML).toContain("This instance is private.");
  });

  test("shows channel placeholders while loading and ignores an older request for the same server", async () => {
    const page = openApp(true);
    await page.settle();
    const pending: Array<(response: Response) => void> = [];
    page.intercept((url) => url === "/api/guilds/server/channels"
      ? new Promise<Response>((resolve) => { pending.push(resolve); })
      : undefined);
    page.selectGuild();
    expect(page.app.innerHTML).toContain('class="channel-skeleton"');
    expect(page.app.innerHTML).toContain("Loading channels");
    expect(page.app.innerHTML).not.toContain("No channels");
    page.selectGuild();
    pending[0](Response.json({ botAdded: true, channels: [{ id: "old", name: "old-channel", type: 0, position: 0 }], roles: [] }));
    await page.settle();
    expect(page.app.innerHTML).toContain('class="channel-skeleton"');
    expect(page.app.innerHTML).not.toContain("old-channel");
    pending[1](Response.json({ botAdded: true, channels: [{ id: "new", name: "new-channel", type: 0, position: 0 }], roles: [] }));
    await page.settle();
    expect(page.app.innerHTML).toContain("new-channel");
    expect(page.app.innerHTML).not.toContain('class="channel-skeleton"');
    expect(page.app.innerHTML).not.toContain("Loading channels");
  });

  test("shows stream placeholders without an empty-state flash while the list is pending", async () => {
    const page = openApp(true);
    await page.settle();
    page.selectGuild();
    await page.settle();
    let resolveStreams!: (response: Response) => void;
    page.intercept((url) => url.endsWith("/streams")
      ? new Promise<Response>((resolve) => { resolveStreams = resolve; })
      : undefined);
    page.action("select-channel", "channel");
    expect(page.app.innerHTML).toContain("stream-skeleton-row");
    expect(page.app.innerHTML).toContain("Loading stream URLs...");
    expect(page.app.innerHTML).toContain('aria-busy="true"');
    expect(page.app.innerHTML).not.toContain("No stream URLs yet.");
    resolveStreams(Response.json({ streams: [] }));
    await page.settle();
    expect(page.app.innerHTML).toContain("No stream URLs yet.");
    expect(page.app.innerHTML).not.toContain("stream-skeleton-row");
  });
});

describe("returning to the app", () => {
  test("refreshes on focus and reloads channels when the selected server gains the bot", async () => {
    const page = openApp();
    await page.settle();
    page.selectGuild();
    expect(page.app.innerHTML).toContain("Add cordstream");
    page.setGuilds([{ id: "server", name: "Server", icon: null, botAdded: true }]);
    page.window.dispatchEvent(new Event("focus"));
    page.document.dispatchEvent(new Event("visibilitychange"));
    await page.settle();
    expect(page.requests.filter((url) => url === "/api/auth/status")).toHaveLength(2);
    expect(page.requests).toContain("/api/guilds/server/channels");
    expect(page.app.innerHTML).toContain("general");
    expect(page.app.innerHTML).not.toContain("Add cordstream");

    page.setGuilds([]);
    page.document.dispatchEvent(new Event("visibilitychange"));
    await page.settle();
    expect(page.app.innerHTML).toContain("Choose a server");
    expect(page.app.innerHTML).not.toContain("general");
  });

  test("refreshes a page restored from browser history", async () => {
    const page = openApp();
    await page.settle();
    page.window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await page.settle();
    expect(page.requests).toHaveLength(2);
  });

  test("keeps the server picker visible when a background refresh fails", async () => {
    const page = openApp();
    await page.settle();
    page.setStatus(502);
    page.window.dispatchEvent(new Event("focus"));
    await page.settle();
    expect(page.app.innerHTML).toContain("Server");
    expect(page.toast.textContent).toContain("Could not refresh");
    expect(page.app.innerHTML).not.toContain("login-button");
  });
});

describe("stream URLs", () => {
  async function openChannel() {
    const page = openApp(true);
    page.setChannels([
      { id: "channel", name: "general", type: 0, position: 0 },
      { id: "other", name: "other", type: 0, position: 1 },
    ]);
    await page.settle();
    page.selectGuild();
    await page.settle();
    page.action("select-channel", "channel");
    await page.settle();
    return page;
  }

  test("loads, creates, and deletes server-backed public links", async () => {
    const page = await openChannel();
    expect(page.requests).toContain("/api/guilds/server/channels/channel/streams");
    expect(page.app.innerHTML).toContain("No stream URLs yet.");
    page.action("create-stream");
    expect(page.app.innerHTML).toContain("Creating stream URL...");
    await page.settle();
    expect(page.app.innerHTML).toContain("http://localhost/stream/server/channel?key=public-key");
    expect(page.app.innerHTML).toContain('target="_blank"');
    expect(page.app.innerHTML).toContain('aria-label="Delete stream URL"');
    expect(page.app.innerHTML).not.toContain('data-action="stream-link"');
    page.action("delete-stream", "public-key");
    expect(page.app.innerHTML).toContain('aria-label="Deleting stream URL"');
    expect(page.app.innerHTML).toContain("Deleting stream URL...");
    await page.settle();
    expect(page.requestDetails).toContainEqual({
      url: "/api/guilds/server/channels/channel/streams/public-key", method: "DELETE",
    });
    expect(page.app.innerHTML).not.toContain("?key=public-key");
    expect(page.toast.textContent).toBe("Stream URL deleted");
  });

  test("keeps links visible during a background session and stream refresh", async () => {
    const page = await openChannel();
    page.action("create-stream");
    await page.settle();
    let resolveSession!: (response: Response) => void;
    let resolveStreams!: (response: Response) => void;
    page.intercept((url) => {
      if (url === "/api/auth/status") return new Promise<Response>((resolve) => { resolveSession = resolve; });
      if (url.endsWith("/streams")) return new Promise<Response>((resolve) => { resolveStreams = resolve; });
    });
    page.window.dispatchEvent(new Event("focus"));
    expect(page.app.innerHTML).toContain("Refreshing servers");
    expect(page.app.innerHTML).toContain("?key=public-key");
    expect(page.app.innerHTML).not.toContain('class="loading-screen"');
    resolveSession(Response.json({ authenticated: true, user: { id: "user", username: "tester" }, guilds: [{ id: "server", name: "Server", icon: null, botAdded: true }] }));
    await page.settle();
    expect(page.app.innerHTML).toContain("Refreshing stream URLs");
    expect(page.app.innerHTML).toContain("?key=public-key");
    expect(page.app.innerHTML).not.toContain("stream-skeleton-row");
    expect(page.app.innerHTML).toContain('aria-label="Copy stream URL"');
    resolveStreams(Response.json({ streams: [{ key: "public-key", url: "http://localhost/stream/server/channel?key=public-key", createdAt: Date.now(), guildId: "server", channelId: "channel" }] }));
    await page.settle();
    expect(page.app.innerHTML).not.toContain("Refreshing servers");
    expect(page.app.innerHTML).not.toContain("Refreshing stream URLs");
  });

  test("preserves links when deletion fails and offers retry after a list failure", async () => {
    const page = await openChannel();
    page.action("create-stream");
    await page.settle();
    page.intercept((url, options) => options?.method === "DELETE"
      ? Response.json({ error: "Could not delete this stream URL." }, { status: 502 })
      : undefined);
    page.action("delete-stream", "public-key");
    await page.settle();
    expect(page.app.innerHTML).toContain("?key=public-key");
    expect(page.toast.textContent).toBe("Could not delete this stream URL.");
    page.intercept((url) => url.endsWith("/streams")
      ? Response.json({ error: "Could not load stream URLs." }, { status: 502 })
      : undefined);
    page.action("select-channel", "other");
    await page.settle();
    expect(page.app.innerHTML).toContain("Could not load stream URLs.");
    expect(page.app.innerHTML).toContain('data-action="retry-streams"');
    expect(page.app.innerHTML).not.toContain("?key=public-key");
    page.intercept(undefined);
    page.action("retry-streams");
    await page.settle();
    expect(page.app.innerHTML).not.toContain("Could not load stream URLs.");
  });

  test("ignores a history response after selecting another channel", async () => {
    const page = await openChannel();
    let resolveList!: (response: Response) => void;
    page.intercept((url) => url === "/api/guilds/server/channels/channel/streams"
      ? new Promise<Response>((resolve) => { resolveList = resolve; })
      : undefined);
    page.action("select-channel", "channel");
    page.action("select-channel", "other");
    await page.settle();
    resolveList(Response.json({ streams: [{
      key: "stale-key", url: "http://localhost/stream/server/channel?key=stale-key", createdAt: Date.now(),
    }] }));
    await page.settle();
    expect(page.app.innerHTML).not.toContain("stale-key");
    expect(page.app.innerHTML).toContain("No stream URLs yet.");
  });

  test("ignores a late create after switching channel and blocks duplicate submissions", async () => {
    const page = await openChannel();
    let resolveCreate!: (response: Response) => void;
    page.intercept((url, options) => options?.method === "POST"
      ? new Promise<Response>((resolve) => { resolveCreate = resolve; })
      : undefined);
    page.action("create-stream");
    page.action("create-stream");
    expect(page.requestDetails.filter((request) => request.method === "POST")).toHaveLength(1);
    page.action("select-channel", "other");
    await page.settle();
    resolveCreate(Response.json({ stream: {
      key: "late-key", url: "http://localhost/stream/server/channel?key=late-key", createdAt: Date.now(),
    } }));
    await page.settle();
    expect(page.app.innerHTML).not.toContain("late-key");
    expect(page.toast.textContent).not.toBe("Stream URL created");
  });

  test("clears the previous user's links when the session changes", async () => {
    const page = await openChannel();
    page.action("create-stream");
    await page.settle();
    page.setUser({ id: "another-user", username: "another" });
    page.window.dispatchEvent(new Event("focus"));
    await page.settle();
    expect(page.app.innerHTML).not.toContain("?key=public-key");
    expect(page.app.innerHTML).toContain("Choose a server");
  });
});
