import { botToken } from "./config";

export type GatewayDispatch = {
  t: string;
  d: Record<string, any>;
  s?: number;
};

export type GatewayStatus = {
  type: "reconnecting" | "ready" | "reset" | "error";
  message?: string;
};

export type GatewaySocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
};

type Timer = { cancel(): void };

export type GatewayOptions = {
  token?: string;
  createSocket?: (url: string) => GatewaySocket;
  gatewayUrl?: string;
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
  idleTimeoutMs?: number;
  identifyIntervalMs?: number;
  now?: () => number;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
};

const dispatches = new Set([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_DELETE_BULK",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "MESSAGE_REACTION_REMOVE_ALL",
  "MESSAGE_REACTION_REMOVE_EMOJI",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "THREAD_UPDATE",
  "THREAD_DELETE",
]);

const fatalCloseMessages: Record<number, string> = {
  4004: "Discord rejected the bot token.",
  4010: "Discord rejected the Gateway shard configuration.",
  4011: "This Discord bot requires Gateway sharding.",
  4012: "Discord rejected the Gateway API version.",
  4013: "Discord rejected the Gateway intents.",
  4014: "Enable the Message Content intent for the bot in the Discord developer portal.",
};

function schedule(callback: () => void, delayMs: number): Timer {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/** A single lazy Gateway connection shared by all channel streams. */
export class DiscordGateway {
  private readonly token: string | undefined;
  private readonly createSocket: (url: string) => GatewaySocket;
  private readonly gatewayUrl: string;
  private readonly readyTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly idleTimeoutMs: number;
  private readonly identifyIntervalMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly listeners = new Map<string, Set<(event: GatewayDispatch) => void>>();
  private readonly statusListeners = new Set<(status: GatewayStatus) => void>();
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void; timer: Timer }>();
  private socket?: GatewaySocket;
  private connectionTimer?: Timer;
  private reconnectTimer?: Timer;
  private heartbeatTimer?: Timer;
  private idleTimer?: Timer;
  private identifyTimer?: Timer;
  private lastIdentifyAt = -Infinity;
  private active = false;
  private ready = false;
  private fatalError?: Error;
  private hasEstablishedSession = false;
  private sequence: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private heartbeatAcknowledged = true;
  private reconnectAttempts = 0;

  constructor(options: GatewayOptions = {}) {
    this.token = options.token ?? botToken;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as GatewaySocket);
    this.gatewayUrl = options.gatewayUrl ?? "wss://gateway.discord.gg";
    this.readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.identifyIntervalMs = options.identifyIntervalMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? schedule;
  }

  subscribe(guildId: string, channelId: string, listener: (event: GatewayDispatch) => void): () => void {
    this.idleTimer?.cancel();
    this.idleTimer = undefined;
    const key = `${guildId}:${channelId}`;
    const listeners = this.listeners.get(key) ?? new Set();
    const subscriber = (event: GatewayDispatch) => listener(event);
    listeners.add(subscriber);
    this.listeners.set(key, listeners);
    this.start();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(subscriber);
      if (!listeners.size) this.listeners.delete(key);
      if (!this.listeners.size) {
        if (this.idleTimeoutMs <= 0 || !this.active) this.stop();
        else this.idleTimer = this.schedule(() => { this.idleTimer = undefined; this.stop(); }, this.idleTimeoutMs);
      }
    };
  }

  subscribeStatus(listener: (status: GatewayStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  waitUntilReady(): Promise<void> {
    this.start();
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: this.schedule(() => {
          this.waiters.delete(waiter);
          reject(new Error("Timed out waiting for the Discord Gateway."));
        }, this.readyTimeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  stop(): void {
    this.active = false;
    this.ready = false;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = undefined;
    this.idleTimer?.cancel();
    this.idleTimer = undefined;
    this.closeSocket(1000, "No active streams");
    this.clearSession();
    this.hasEstablishedSession = false;
    this.reconnectAttempts = 0;
    this.rejectWaiters(new Error("The Discord Gateway connection was stopped."));
  }

  private start(): void {
    if (this.active || this.fatalError) return;
    if (!this.token) {
      this.fail(new Error("DISCORD_BOT_TOKEN is required for live streams."));
      return;
    }
    this.active = true;
    this.connect();
  }

  private connect(): void {
    if (!this.active || this.socket) return;
    let socket: GatewaySocket;
    try {
      const url = new URL(this.sessionId ? this.resumeUrl ?? this.gatewayUrl : this.gatewayUrl);
      url.searchParams.set("v", "10");
      url.searchParams.set("encoding", "json");
      url.searchParams.delete("compress");
      socket = this.createSocket(url.toString());
    } catch {
      this.reconnect("Could not connect to the Discord Gateway.");
      return;
    }
    this.socket = socket;
    let receivedHello = false;
    this.connectionTimer = this.schedule(() => {
      if (this.socket === socket) this.reconnect("Discord did not complete the Gateway handshake.");
    }, this.readyTimeoutMs);
    socket.onopen = () => {};
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let packet: { op?: number; d?: any; s?: number; t?: string };
      try {
        if (typeof event.data !== "string") return;
        packet = JSON.parse(event.data);
        if (!packet || typeof packet !== "object") return;
      } catch {
        this.reconnect("Discord sent an invalid Gateway packet.");
        return;
      }
      if (typeof packet.s === "number") this.sequence = packet.s;
      switch (packet.op) {
        case 10: {
          const interval = packet.d?.heartbeat_interval;
          if (receivedHello || typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
            this.reconnect("Discord sent an invalid Gateway heartbeat interval.");
            return;
          }
          receivedHello = true;
          this.heartbeatAcknowledged = true;
          const heartbeat = () => {
            if (this.socket !== socket) return;
            if (!this.heartbeatAcknowledged) {
              this.reconnect("Discord did not acknowledge the Gateway heartbeat.");
              return;
            }
            this.sendHeartbeat();
            if (this.socket === socket) this.heartbeatTimer = this.schedule(heartbeat, interval);
          };
          this.heartbeatTimer = this.schedule(heartbeat, this.random() * interval);
          if (this.sessionId && this.sequence !== null) {
            this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } });
          } else {
            const identify = () => {
              this.identifyTimer = undefined;
              if (this.socket !== socket || !this.active) return;
              this.lastIdentifyAt = this.now();
              this.send({
                op: 2,
                d: {
                  token: this.token,
                  intents: 1 | 512 | 1024 | 32768,
                  properties: { os: process.platform, browser: "cordstream", device: "cordstream" },
                },
              });
            };
            const delay = this.identifyIntervalMs - (this.now() - this.lastIdentifyAt);
            if (delay > 0) this.identifyTimer = this.schedule(identify, delay);
            else identify();
          }
          break;
        }
        case 11:
          this.heartbeatAcknowledged = true;
          break;
        case 1:
          this.sendHeartbeat();
          break;
        case 7:
          this.reconnect("Discord requested a Gateway reconnect.", 0);
          break;
        case 9:
          if (packet.d !== true) this.clearSession();
          this.reconnect("Discord invalidated the Gateway session.", 1_000 + this.random() * 4_000);
          break;
        case 0: {
          if (packet.t === "READY") {
            if (typeof packet.d?.session_id !== "string") {
              this.reconnect("Discord sent an invalid Gateway session.");
              return;
            }
            this.sessionId = packet.d.session_id;
            this.resumeUrl = packet.d.resume_gateway_url;
            if (this.hasEstablishedSession) {
              this.notifyStatus({ type: "reset", message: "Discord could not resume the previous session. Reconnect for fresh message history." });
              if (this.socket !== socket || !this.active) return;
            }
            this.hasEstablishedSession = true;
            this.markReady();
          } else if (packet.t === "RESUMED") {
            this.markReady();
          } else if (packet.t && dispatches.has(packet.t) && packet.d && typeof packet.d === "object") {
            const channelId = packet.d.channel_id ?? packet.d.id;
            const listeners = this.listeners.get(`${packet.d.guild_id}:${channelId}`);
            if (!listeners) return;
            const dispatch: GatewayDispatch = { t: packet.t, d: packet.d };
            if (typeof packet.s === "number") dispatch.s = packet.s;
            for (const listener of [...listeners]) {
              try { listener(dispatch); } catch { /* One consumer cannot interrupt other streams. */ }
            }
          }
          break;
        }
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      const fatalMessage = fatalCloseMessages[event.code];
      if (fatalMessage) {
        this.fail(new Error(fatalMessage));
        return;
      }
      if ([1000, 1001, 4003, 4007, 4009].includes(event.code)) this.clearSession();
      this.reconnect(`Discord closed the Gateway connection (${event.code}).`, event.code === 4008 ? 5_000 : undefined);
    };
    socket.onerror = () => {
      if (this.socket === socket) this.reconnect("The Discord Gateway connection failed.");
    };
  }

  private send(packet: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(packet));
    } catch {
      this.reconnect("Could not send a Discord Gateway packet.");
    }
  }

  private sendHeartbeat(): void {
    this.heartbeatAcknowledged = false;
    this.send({ op: 1, d: this.sequence });
  }

  private markReady(): void {
    this.ready = true;
    this.reconnectAttempts = 0;
    this.connectionTimer?.cancel();
    this.connectionTimer = undefined;
    for (const waiter of this.waiters) {
      waiter.timer.cancel();
      waiter.resolve();
    }
    this.waiters.clear();
    this.notifyStatus({ type: "ready" });
  }

  private clearSession(): void {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.sequence = null;
  }

  private closeSocket(code = 4000, reason = "Reconnecting"): void {
    this.connectionTimer?.cancel();
    this.connectionTimer = undefined;
    this.heartbeatTimer?.cancel();
    this.heartbeatTimer = undefined;
    this.identifyTimer?.cancel();
    this.identifyTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < 2) {
      try { socket.close(code, reason); } catch { /* A failed socket can already be closed. */ }
    }
  }

  private reconnect(message: string, delayMs?: number): void {
    this.ready = false;
    this.closeSocket();
    if (!this.active || this.reconnectTimer) return;
    const delay = delayMs ?? Math.min(30_000, this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts, 5)) * (0.8 + this.random() * 0.4);
    this.reconnectAttempts++;
    this.notifyStatus({ type: "reconnecting", message });
    if (!this.active) return;
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private fail(error: Error): void {
    this.active = false;
    this.ready = false;
    this.fatalError = error;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = undefined;
    this.closeSocket();
    this.rejectWaiters(error);
    this.notifyStatus({ type: "error", message: error.message });
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      waiter.timer.cancel();
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private notifyStatus(status: GatewayStatus): void {
    for (const listener of [...this.statusListeners]) {
      try { listener(status); } catch { /* Status listeners have independent lifetimes. */ }
    }
  }
}

export const discordGateway = new DiscordGateway();
