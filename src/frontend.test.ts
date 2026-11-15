import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const build = await Bun.build({
  entrypoints: [`${import.meta.dir}/../public/app.js`],
  target: "browser",
  format: "iife",
});
if (!build.success) throw new Error(`Browser build failed: ${build.logs.join("\n")}`);
const script = await build.outputs[0].text();

function openApp() {
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
  let guilds = [{ id: "server", name: "Server", icon: null, botAdded: false }];
  let status = 200;
  const requests: string[] = [];
  runInNewContext(script, {
    window, document, URLSearchParams,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url: string) => {
      requests.push(url);
      return url === "/api/auth/status"
        ? Response.json({ authenticated: true, user: { id: "user", username: "tester" }, guilds }, { status })
        : Response.json({ botAdded: true, channels: [{ id: "channel", name: "general", type: 0, position: 0 }], roles: [] });
    },
  });
  return {
    app, toast, window, document, requests,
    setGuilds: (next: typeof guilds) => { guilds = next; },
    setStatus: (next: number) => { status = next; },
    async settle() { await Bun.sleep(0); },
    selectGuild() {
      const event = new Event("click");
      Object.defineProperty(event, "target", {
        value: { closest: () => ({ dataset: { action: "select-guild", id: "server" } }) },
      });
      app.dispatchEvent(event);
    },
  };
}

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
