import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { GatewayDispatch, GatewayStatus } from "../src/gateway";
import { streamRoutes } from "../src/routes/stream";
import { streamStore, type StoredStream } from "../src/stream-store";
import { createStreamResponse, type StreamDependencies } from "../src/streaming";

const stream: StoredStream = {
  key: "public-stream-key", guildId: "guild", channelId: "channel", ownerId: "owner", createdAt: 1_700_000_000_000, demo: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeDependencies() {
  const events = new Set<(event: GatewayDispatch) => void>();
  const statuses = new Set<(status: GatewayStatus) => void>();
  const deleted = new Set<(stream: StoredStream) => void>();
  let readyCalls = 0;
  let historyCalls = 0;
  let historySignal: AbortSignal | undefined;
  const dependencies: StreamDependencies = {
    gateway: {
      subscribe: (_guildId, _channelId, listener) => {
        events.add(listener);
        return () => { events.delete(listener); };
      },
      subscribeStatus: (listener) => {
        statuses.add(listener);
        return () => { statuses.delete(listener); };
      },
      waitUntilReady: async () => { readyCalls++; },
    },
    history: async (_channelId, signal) => { historyCalls++; historySignal = signal; return []; },
    subscribeDeleted: (listener) => {
      deleted.add(listener);
      return () => { deleted.delete(listener); };
    },
    heartbeatMs: 15_000,
    maxBufferEvents: 512,
    maxBufferBytes: 4 * 1024 * 1024,
    maxQueueBytes: 4 * 1024 * 1024,
  };
  return {
    dependencies, events, statuses, deleted,
    get readyCalls() { return readyCalls; },
    get historyCalls() { return historyCalls; },
    get historySignal() { return historySignal; },
    emit(t: string, d: Record<string, unknown>) { for (const listener of events) listener({ t, d }); },
    status(status: GatewayStatus) { for (const listener of statuses) listener(status); },
    remove(record: StoredStream) { for (const listener of deleted) listener(record); },
  };
}

type EventFrame = { event: string; data: any };

function readEvents(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    reader,
    async next(): Promise<EventFrame | undefined> {
      while (true) {
        let end: number;
        while ((end = text.indexOf("\n\n")) !== -1) {
          const frame = text.slice(0, end);
          text = text.slice(end + 2);
          const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (event && data) return { event, data: JSON.parse(data) };
        }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

const connections: ReturnType<typeof readEvents>[] = [];

function connect(fake: ReturnType<typeof fakeDependencies>, record = stream, request = new Request("http://localhost/stream/guild/channel?key=public-stream-key")) {
  const response = createStreamResponse(request, record, fake.dependencies);
  const events = readEvents(response);
  connections.push(events);
  return { response, events };
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.reader.cancel();
});

describe("public Discord SSE", () => {
  test("preserves raw history and buffers live messages until the oldest-first snapshot", async () => {
    const fake = fakeDependencies();
    const history = deferred<Record<string, unknown>[]>();
    fake.dependencies.history = async () => history.promise;
    const older = { id: "100", author: { username: "alice", global_name: "Alice" }, member: { nick: "Guild Alice" }, content: "hello" };
    const newer = {
      id: "200", channel_id: "channel", author: { username: "bot", global_name: null, bot: true },
      attachments: [{ id: "attachment", url: "https://cdn.discordapp.com/image.png", proxy_url: "https://media.discordapp.net/image.png" }],
      embeds: [{ title: "Rich embed", fields: [{ name: "Field", value: "Value", inline: true }], image: { url: "https://example.com/image.png", proxy_url: "https://proxy.example/image.png", width: 100, height: 80 } }],
      components: [{ type: 1, components: [{ type: 2, label: "Button" }] }], poll: { question: { text: "Question?" } },
      referenced_message: older, future_api_field: { value: [1, 2] },
    };
    const { response, events } = connect(fake);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const created = { ...newer, id: "300", guild_id: "guild", channel_id: "channel", content: "during history" };
    fake.emit("MESSAGE_CREATE", created);
    history.resolve([newer, older]);
    expect(await events.next()).toEqual({ event: "snapshot", data: { guild_id: "guild", channel_id: "channel", messages: [older, newer] } });
    expect(await events.next()).toEqual({ event: "MESSAGE_CREATE", data: created });
    const update = { id: "300", guild_id: "guild", channel_id: "channel", embeds: [], edited_timestamp: "2026-11-16T12:00:00Z" };
    fake.emit("MESSAGE_UPDATE", update);
    expect(await events.next()).toEqual({ event: "MESSAGE_UPDATE", data: update });
    expect(update).not.toHaveProperty("author");
  });

  test("shares one in-flight history request between concurrent channel subscribers", async () => {
    const fake = fakeDependencies();
    const history = deferred<Record<string, unknown>[]>();
    let historyCalls = 0;
    let historySignal: AbortSignal | undefined;
    fake.dependencies.history = async (_channelId, signal) => { historyCalls++; historySignal = signal; return history.promise; };
    const firstAbort = new AbortController();
    const first = connect(fake, stream, new Request("http://localhost", { signal: firstAbort.signal }));
    const second = connect(fake);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(historyCalls).toBe(1);
    firstAbort.abort();
    expect(await first.events.next()).toBeUndefined();
    expect(historySignal?.aborted).toBe(false);
    history.resolve([]);
    expect(await second.events.next()).toEqual({ event: "snapshot", data: { guild_id: "guild", channel_id: "channel", messages: [] } });
    expect(historyCalls).toBe(1);
    await second.events.reader.cancel();
    expect(historySignal?.aborted).toBe(true);
  });

  test.each([
    "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK",
    "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE", "MESSAGE_REACTION_REMOVE_ALL", "MESSAGE_REACTION_REMOVE_EMOJI",
    "CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_UPDATE", "THREAD_DELETE",
  ])("forwards scoped %s data unchanged", async (name) => {
    const fake = fakeDependencies();
    const { events } = connect(fake);
    await events.next();
    const channelEvent = name.startsWith("CHANNEL_") || name.startsWith("THREAD_");
    const data = { guild_id: "guild", ...(channelEvent ? { id: "channel" } : { channel_id: "channel", id: "message" }), ids: ["message-1", "message-2"], emoji: { name: "wave", id: null } };
    fake.emit(name, { ...data, guild_id: "another-guild" });
    fake.emit(name, { ...data, ...(channelEvent ? { id: "another-channel" } : { channel_id: "another-channel" }) });
    fake.emit("UNRELATED_EVENT", data);
    fake.emit(name, data);
    expect(await events.next()).toEqual({ event: name, data });
  });

  test("deleting a key closes only its subscribers and releases all listeners", async () => {
    const fake = fakeDependencies();
    const { events } = connect(fake);
    await events.next();
    fake.remove({ ...stream, key: "different-key" });
    fake.emit("MESSAGE_DELETE_BULK", { guild_id: "guild", channel_id: "channel", ids: ["a", "b"] });
    expect((await events.next())?.event).toBe("MESSAGE_DELETE_BULK");
    fake.remove(stream);
    expect(await events.next()).toEqual({ event: "stream_deleted", data: { guild_id: "guild", channel_id: "channel" } });
    expect(await events.next()).toBeUndefined();
    expect(fake.events.size + fake.statuses.size + fake.deleted.size).toBe(0);
  });

  test("request abort cancels history and releases listeners", async () => {
    const fake = fakeDependencies();
    const history = deferred<Record<string, unknown>[]>();
    let historySignal: AbortSignal | undefined;
    fake.dependencies.history = async (_channelId, signal) => { historySignal = signal; return history.promise; };
    const abort = new AbortController();
    const { events } = connect(fake, stream, new Request("http://localhost", { signal: abort.signal }));
    await Bun.sleep(0);
    abort.abort();
    expect(await events.next()).toBeUndefined();
    expect(historySignal?.aborted).toBe(true);
    expect(fake.events.size + fake.statuses.size + fake.deleted.size).toBe(0);
    history.resolve([]);
  });

  test("reader cancellation releases Gateway and deletion listeners", async () => {
    const fake = fakeDependencies();
    const { events } = connect(fake);
    await events.next();
    expect(fake.events.size).toBe(1);
    await events.reader.cancel();
    expect(fake.events.size + fake.statuses.size + fake.deleted.size).toBe(0);
    expect(fake.historySignal?.aborted).toBe(true);
  });

  test.each(["gateway", "history"])("reports %s failures and closes", async (source) => {
    const fake = fakeDependencies();
    if (source === "gateway") fake.dependencies.gateway.waitUntilReady = async () => { throw new Error("Gateway unavailable"); };
    else fake.dependencies.history = async () => { throw new Error("History unavailable"); };
    const { events } = connect(fake);
    expect(await events.next()).toEqual({ event: "stream_error", data: { code: `${source}_error`, message: source === "gateway" ? "Gateway unavailable" : "History unavailable" } });
    expect(await events.next()).toBeUndefined();
    expect(fake.events.size + fake.statuses.size + fake.deleted.size).toBe(0);
  });

  test("keeps resumable reconnects open but closes for a fresh Gateway session", async () => {
    const fake = fakeDependencies();
    const { events } = connect(fake);
    await events.next();
    fake.status({ type: "reconnecting" });
    const data = { id: "message", guild_id: "guild", channel_id: "channel" };
    fake.emit("MESSAGE_DELETE", data);
    expect(await events.next()).toEqual({ event: "MESSAGE_DELETE", data });
    fake.status({ type: "reset" });
    expect((await events.next())?.data.code).toBe("gateway_reset");
    expect(await events.next()).toBeUndefined();
  });

  test("reports fatal Gateway errors to an already open stream", async () => {
    const fake = fakeDependencies();
    const { events } = connect(fake);
    await events.next();
    fake.status({ type: "error", message: "Enable Message Content Intent" });
    expect(await events.next()).toEqual({ event: "stream_error", data: { code: "gateway_error", message: "Enable Message Content Intent" } });
    expect(await events.next()).toBeUndefined();
  });

  test("cleans up synchronous Gateway startup errors without starting another readiness wait", async () => {
    const fake = fakeDependencies();
    const subscribe = fake.dependencies.gateway.subscribe;
    fake.dependencies.gateway.subscribe = (guildId, channelId, listener) => {
      const release = subscribe(guildId, channelId, listener);
      fake.status({ type: "error", message: "Bot token missing" });
      return release;
    };
    const { events } = connect(fake);
    expect(await events.next()).toEqual({ event: "stream_error", data: { code: "gateway_error", message: "Bot token missing" } });
    expect(await events.next()).toBeUndefined();
    expect(fake.readyCalls).toBe(0);
    expect(fake.events.size + fake.statuses.size + fake.deleted.size).toBe(0);
  });

  test("bounds pending history events and closes on overflow", async () => {
    const fake = fakeDependencies();
    const history = deferred<Record<string, unknown>[]>();
    fake.dependencies.history = async () => history.promise;
    fake.dependencies.maxBufferEvents = 1;
    const { events } = connect(fake);
    const data = { id: "message", guild_id: "guild", channel_id: "channel" };
    fake.emit("MESSAGE_CREATE", data);
    fake.emit("MESSAGE_UPDATE", data);
    expect((await events.next())?.data.code).toBe("buffer_overflow");
    expect(await events.next()).toBeUndefined();
    expect(fake.events.size + fake.statuses.size + fake.deleted.size).toBe(0);
    history.resolve([]);
  });

  test("bounds queued output for slow consumers", async () => {
    const fake = fakeDependencies();
    fake.dependencies.maxQueueBytes = 512;
    const { events } = connect(fake);
    await events.next();
    fake.emit("MESSAGE_CREATE", { id: "message", guild_id: "guild", channel_id: "channel", content: "x".repeat(1000) });
    expect((await events.next())?.data.code).toBe("slow_consumer");
    expect(await events.next()).toBeUndefined();
  });

  test("demo streams identify synthetic history and never contact Discord", async () => {
    const fake = fakeDependencies();
    const { events } = connect(fake, { ...stream, demo: true });
    const snapshot = await events.next();
    expect(snapshot?.event).toBe("snapshot");
    expect(snapshot?.data.demo).toBe(true);
    expect(snapshot?.data.messages).toHaveLength(2);
    expect(snapshot?.data.messages[0].author.username).toBe("cordstream");
    expect(fake.readyCalls).toBe(0);
    expect(fake.historyCalls).toBe(0);
    expect(fake.events.size + fake.statuses.size).toBe(0);
  });

  test("sends heartbeat comments without application events", async () => {
    const fake = fakeDependencies();
    fake.dependencies.heartbeatMs = 1;
    const response = createStreamResponse(new Request("http://localhost"), { ...stream, demo: true }, fake.dependencies);
    const events = readEvents(response);
    connections.push(events);
    await events.next();
    const heartbeat = await events.reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");
  });
});

describe("public stream route validation", () => {
  test.each(["", "?key=", "?key=one&key=two"])("rejects malformed keys without requiring a login: %s", async (query) => {
    const response = await streamRoutes.handle(new Request(`http://localhost/stream/guild/channel${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  });

  test("passes key and both channel identifiers to the store and returns CORS on 404", async () => {
    const find = spyOn(streamStore, "find").mockReturnValue(undefined);
    try {
      const response = await streamRoutes.handle(new Request("http://localhost/stream/another-guild/another-channel?key=public-key"));
      expect(find).toHaveBeenCalledWith("public-key", "another-guild", "another-channel");
      expect(response.status).toBe(404);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      find.mockRestore();
    }
  });

  test("answers a cross-origin preflight without authentication", async () => {
    const response = await streamRoutes.handle(new Request("http://localhost/stream/guild/channel?key=public-key", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});
