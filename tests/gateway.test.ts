import { describe, expect, test } from "bun:test";
import { DiscordGateway, type GatewayDispatch, type GatewayOptions, type GatewaySocket, type GatewayStatus } from "../src/gateway";

class FakeClock {
  now = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback(): void }>();

  schedule = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return { cancel: () => { this.timers.delete(id); } };
  };

  advance(delayMs: number) {
    const destination = this.now + delayMs;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > destination) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = destination;
  }

  get pending() { return this.timers.size; }
}

class FakeSocket implements GatewaySocket {
  readyState = 0;
  onopen: GatewaySocket["onopen"] = null;
  onmessage: GatewaySocket["onmessage"] = null;
  onclose: GatewaySocket["onclose"] = null;
  onerror: GatewaySocket["onerror"] = null;
  sent: any[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly url: string) {}

  open() { this.readyState = 1; this.onopen?.(); }
  receive(packet: unknown) { this.onmessage?.({ data: JSON.stringify(packet) }); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.readyState = 3; this.closed.push({ code, reason }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  hello(interval = 50) { this.open(); this.receive({ op: 10, d: { heartbeat_interval: interval } }); }
  ready(sequence = 1) {
    this.receive({ op: 0, t: "READY", s: sequence, d: { session_id: "session", resume_gateway_url: "wss://resume.discord.gg" } });
  }
}

function fixture(options: Partial<GatewayOptions> = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const gateway = new DiscordGateway({
    token: "test-token",
    readyTimeoutMs: 200,
    reconnectDelayMs: 10,
    idleTimeoutMs: 0,
    identifyIntervalMs: 0,
    now: () => clock.now,
    random: () => 0.5,
    schedule: clock.schedule,
    createSocket(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { gateway, clock, sockets };
}

describe("Discord Gateway", () => {
  test("starts lazily, shares its connection, and waits for READY rather than the socket opening", async () => {
    const { gateway, sockets, clock } = fixture();
    expect(sockets).toHaveLength(0);
    const unsubscribe = gateway.subscribe("guild", "channel", () => {});
    const unsubscribeOther = gateway.subscribe("guild", "other", () => {});
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    let ready = false;
    const waiting = gateway.waitUntilReady().then(() => { ready = true; });
    socket.hello();
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: "test-token", intents: 34305 } });
    socket.ready();
    await waiting;
    expect(ready).toBe(true);
    unsubscribe();
    expect(socket.closed).toHaveLength(0);
    unsubscribeOther();
    expect(socket.closed[0]?.code).toBe(1000);
    expect(clock.pending).toBe(0);
  });

  test("forwards raw message, reaction, channel, and thread data only to the matching channel", () => {
    const { gateway, sockets } = fixture();
    const received: GatewayDispatch[] = [];
    const other: GatewayDispatch[] = [];
    gateway.subscribe("guild", "channel", (dispatch) => received.push(dispatch));
    gateway.subscribe("other-guild", "channel", (dispatch) => other.push(dispatch));
    const socket = sockets[0]!;
    socket.hello();
    socket.ready();
    const message = {
      id: "message",
      guild_id: "guild",
      channel_id: "channel",
      author: { id: "author", username: "person", global_name: "A Person" },
      member: { nick: "Nickname" },
      embeds: [{ fields: [{ name: "Field", value: "Value" }], image: { url: "https://image", proxy_url: "https://proxy" } }],
      attachments: [{ id: "attachment", proxy_url: "https://attachment" }],
      unknown_future_field: { keep: true },
    };
    socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: message });
    expect(received[0]).toEqual({ t: "MESSAGE_CREATE", s: 2, d: message });
    socket.receive({ op: 0, t: "MESSAGE_UPDATE", s: 3, d: { guild_id: "guild", channel_id: "elsewhere", id: "message", content: "edited" } });
    expect(received).toHaveLength(1);
    expect(other).toHaveLength(0);
    for (const t of ["MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE", "MESSAGE_REACTION_REMOVE_ALL", "MESSAGE_REACTION_REMOVE_EMOJI"]) {
      socket.receive({ op: 0, t, d: { guild_id: "guild", channel_id: "channel", id: "message" } });
    }
    for (const t of ["CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_UPDATE", "THREAD_DELETE"]) {
      socket.receive({ op: 0, t, d: { guild_id: "guild", id: "channel", name: "Updated channel" } });
    }
    expect(received).toHaveLength(12);
    gateway.stop();
  });

  test("resumes from the last sequence and forwards replayed events without requesting a reset", async () => {
    const { gateway, sockets, clock } = fixture();
    const statuses: GatewayStatus[] = [];
    const events: GatewayDispatch[] = [];
    gateway.subscribeStatus((status) => statuses.push(status));
    gateway.subscribe("guild", "channel", (event) => events.push(event));
    sockets[0]!.hello();
    sockets[0]!.ready(5);
    sockets[0]!.receive({ op: 0, t: "MESSAGE_CREATE", s: 8, d: { guild_id: "guild", channel_id: "channel", id: "one" } });
    sockets[0]!.serverClose(1006);
    const waiting = gateway.waitUntilReady();
    clock.advance(10);
    expect(sockets).toHaveLength(2);
    const resumed = sockets[1]!;
    expect(resumed.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    resumed.hello();
    expect(resumed.sent[0]).toEqual({ op: 6, d: { token: "test-token", session_id: "session", seq: 8 } });
    resumed.receive({ op: 0, t: "MESSAGE_DELETE", s: 9, d: { guild_id: "guild", channel_id: "channel", id: "one" } });
    resumed.receive({ op: 0, t: "RESUMED", s: 10, d: {} });
    await waiting;
    expect(events.map((event) => event.t)).toEqual(["MESSAGE_CREATE", "MESSAGE_DELETE"]);
    expect(statuses.map((status) => status.type)).toEqual(["ready", "reconnecting", "ready"]);
    gateway.stop();
  });

  test("requests a fresh snapshot after an invalid session cannot resume", async () => {
    const { gateway, sockets, clock } = fixture();
    const statuses: GatewayStatus[] = [];
    gateway.subscribeStatus((status) => statuses.push(status));
    gateway.subscribe("guild", "channel", () => {});
    sockets[0]!.hello();
    sockets[0]!.ready();
    sockets[0]!.receive({ op: 9, d: false });
    // The Gateway requires a randomized 1-5 second pause after INVALID_SESSION.
    clock.advance(3_000);
    const waiting = gateway.waitUntilReady();
    const fresh = sockets[1]!;
    fresh.hello();
    expect(fresh.sent[0]?.op).toBe(2);
    fresh.ready();
    await waiting;
    expect(statuses.map((status) => status.type)).toEqual(["ready", "reconnecting", "reset", "ready"]);
    gateway.stop();
  });

  test("reconnects a connection with missing heartbeat acknowledgements", () => {
    const { gateway, sockets, clock } = fixture();
    gateway.subscribe("guild", "channel", () => {});
    const socket = sockets[0]!;
    socket.hello();
    socket.ready(4);
    clock.advance(25);
    expect(socket.sent[1]).toEqual({ op: 1, d: 4 });
    clock.advance(50);
    expect(socket.closed[0]?.code).toBe(4000);
    clock.advance(10);
    expect(sockets).toHaveLength(2);
    gateway.stop();
    expect(clock.pending).toBe(0);
  });

  test("honors heartbeat acknowledgements and server-requested heartbeats", () => {
    const { gateway, sockets, clock } = fixture();
    gateway.subscribe("guild", "channel", () => {});
    const socket = sockets[0]!;
    socket.hello();
    socket.ready();
    clock.advance(25);
    socket.receive({ op: 11 });
    clock.advance(50);
    expect(socket.closed).toHaveLength(0);
    socket.receive({ op: 11 });
    socket.receive({ op: 1 });
    expect(socket.sent.filter((packet) => packet.op === 1)).toHaveLength(3);
    gateway.stop();
  });

  test("fails readiness and notifies consumers for a fatal intent error", async () => {
    const { gateway, sockets, clock } = fixture();
    const statuses: GatewayStatus[] = [];
    gateway.subscribeStatus((status) => statuses.push(status));
    gateway.subscribe("guild", "channel", () => {});
    const waiting = gateway.waitUntilReady();
    sockets[0]!.serverClose(4014);
    await expect(waiting).rejects.toThrow("Message Content intent");
    expect(statuses[0]).toMatchObject({ type: "error" });
    expect(clock.pending).toBe(0);
    await expect(gateway.waitUntilReady()).rejects.toThrow("Message Content intent");
    expect(sockets).toHaveLength(1);
    gateway.stop();
  });

  test("bounds readiness waits when Discord never finishes connecting", async () => {
    const { gateway, clock } = fixture();
    gateway.subscribe("guild", "channel", () => {});
    const waiting = gateway.waitUntilReady();
    clock.advance(200);
    await expect(waiting).rejects.toThrow("Timed out");
    gateway.stop();
    expect(clock.pending).toBe(0);
  });

  test("rejects without a token and never creates a socket", async () => {
    let socketCreated = false;
    const gateway = new DiscordGateway({ token: "", createSocket() { socketCreated = true; throw new Error("unexpected"); } });
    await expect(gateway.waitUntilReady()).rejects.toThrow("DISCORD_BOT_TOKEN");
    expect(socketCreated).toBe(false);
  });

  test("reuses an idle connection and cancels its grace timer when another client subscribes", () => {
    const { gateway, clock, sockets } = fixture({ idleTimeoutMs: 30_000 });
    const unsubscribe = gateway.subscribe("guild", "channel", () => {});
    const socket = sockets[0]!;
    socket.hello(100_000);
    socket.ready();
    unsubscribe();
    clock.advance(1_000);
    expect(socket.closed).toHaveLength(0);
    const nextUnsubscribe = gateway.subscribe("guild", "channel", () => {});
    // Calling an earlier unsubscribe twice cannot remove a newer subscription.
    unsubscribe();
    clock.advance(30_000);
    expect(sockets).toHaveLength(1);
    expect(socket.closed).toHaveLength(0);
    nextUnsubscribe();
    clock.advance(30_000);
    expect(socket.closed[0]?.code).toBe(1000);
    expect(clock.pending).toBe(0);
  });

  test("spaces IDENTIFY packets across stopped connections to honor Discord's session limit", () => {
    const { gateway, clock, sockets } = fixture({ identifyIntervalMs: 5_000, readyTimeoutMs: 20_000 });
    gateway.subscribe("guild", "channel", () => {});
    sockets[0]!.hello(100_000);
    expect(sockets[0]!.sent[0]?.op).toBe(2);
    gateway.stop();
    clock.advance(1_000);
    gateway.subscribe("guild", "channel", () => {});
    const next = sockets[1]!;
    next.hello(100_000);
    expect(next.sent).toHaveLength(0);
    clock.advance(3_999);
    expect(next.sent).toHaveLength(0);
    clock.advance(1);
    expect(next.sent[0]?.op).toBe(2);
    gateway.stop();
    expect(clock.pending).toBe(0);
  });
});
