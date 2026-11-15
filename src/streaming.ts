import { botToken, discordApi } from "./config";
import { discordGateway, type DiscordGateway, type GatewayDispatch } from "./gateway";
import { streamStore, type StoredStream } from "./stream-store";

type RawMessage = Record<string, unknown>;
type StreamGateway = Pick<DiscordGateway, "subscribe" | "subscribeStatus" | "waitUntilReady">;

export type StreamDependencies = {
  gateway: StreamGateway;
  history: (channelId: string, signal: AbortSignal) => Promise<RawMessage[]>;
  subscribeDeleted: (listener: (stream: StoredStream) => void) => () => void;
  heartbeatMs: number;
  maxBufferEvents: number;
  maxBufferBytes: number;
  maxQueueBytes: number;
};

const encoder = new TextEncoder();
const liveEvents = new Set([
  "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK",
  "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE", "MESSAGE_REACTION_REMOVE_ALL", "MESSAGE_REACTION_REMOVE_EMOJI",
  "CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_UPDATE", "THREAD_DELETE",
]);

export const publicStreamHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

async function fetchMessageHistory(channelId: string, signal: AbortSignal): Promise<RawMessage[]> {
  if (!botToken) throw new Error("The Discord bot token is not configured.");
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${discordApi}/channels/${encodeURIComponent(channelId)}/messages?limit=50`, {
    headers: { Authorization: `Bot ${botToken}` },
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error("The bot needs View Channel and Read Message History in this channel.");
    if (response.status === 404) throw new Error("The Discord channel is unavailable.");
    throw new Error(`Discord message history returned HTTP ${response.status}.`);
  }
  const messages: unknown = await response.json();
  if (!Array.isArray(messages) || messages.some((message) => !message || typeof message !== "object" || typeof message.id !== "string")) {
    throw new Error("Discord returned invalid message history.");
  }
  return messages.slice(0, 50) as RawMessage[];
}

function demoMessages(stream: StoredStream): RawMessage[] {
  return [
    {
      id: "demo-message-1", channel_id: stream.channelId, guild_id: stream.guildId,
      type: 0, content: "This is a demo channel. Connect your Discord bot to stream real messages.",
      author: { id: "demo-author", username: "cordstream", global_name: "Cordstream demo", avatar: null, bot: true },
      member: { nick: "Cordstream demo", roles: [] },
      timestamp: new Date(stream.createdAt).toISOString(), edited_timestamp: null,
      attachments: [], embeds: [], mentions: [], mention_roles: [], pinned: false, mention_everyone: false, tts: false, flags: 0,
    },
    {
      id: "demo-message-2", channel_id: stream.channelId, guild_id: stream.guildId,
      type: 0, content: "Stream events include the full message payload, including embeds and attachments.",
      author: { id: "demo-author", username: "cordstream", global_name: "Cordstream demo", avatar: null, bot: true },
      member: { nick: "Cordstream demo", roles: [] },
      timestamp: new Date(stream.createdAt + 1).toISOString(), edited_timestamp: null,
      attachments: [], embeds: [{ type: "rich", title: "Example embed", description: "This message is synthetic demo data.", fields: [{ name: "Events", value: "Create, edit, delete and reactions", inline: false }] }],
      mentions: [], mention_roles: [], pinned: false, mention_everyone: false, tts: false, flags: 0,
    },
  ];
}

function encodeEvent(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventMatches(event: GatewayDispatch, stream: StoredStream) {
  const channelId = event.t.startsWith("CHANNEL_") || event.t.startsWith("THREAD_") ? event.d.id : event.d.channel_id;
  return liveEvents.has(event.t) && event.d.guild_id === stream.guildId && channelId === stream.channelId;
}

/** Open one public SSE connection. Each connection starts with a fresh last-50 snapshot. */
export function createStreamResponse(request: Request, stream: StoredStream, overrides: Partial<StreamDependencies> = {}) {
  const dependencies: StreamDependencies = {
    gateway: discordGateway,
    history: fetchMessageHistory,
    subscribeDeleted: (listener) => streamStore.subscribeDeleted(listener),
    heartbeatMs: 15_000,
    maxBufferEvents: 512,
    maxBufferBytes: 4 * 1024 * 1024,
    maxQueueBytes: 4 * 1024 * 1024,
    ...overrides,
  };
  const abort = new AbortController();
  const cleanups: Array<() => void> = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let initialized = false;
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function cleanup() {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    abort.abort();
    for (const release of cleanups.splice(0)) {
      try { release(); } catch { /* Other subscriptions still need cleanup. */ }
    }
    buffered = [];
    bufferedBytes = 0;
  }

  function onCleanup(release: () => void) {
    if (closed) release();
    else cleanups.push(release);
  }

  function close() {
    if (closed) return;
    closed = true;
    cleanup();
    controller.close();
  }

  function terminate(code: string, message: string) {
    if (closed) return;
    // The final small frame may exceed the queue limit so a slow client can learn why it closed.
    controller.enqueue(encodeEvent("stream_error", { code, message }));
    close();
  }

  function enqueue(frame: Uint8Array) {
    if (closed) return false;
    if (frame.byteLength > (controller.desiredSize ?? 0)) {
      terminate("slow_consumer", "This connection fell behind. Reconnect to fetch the latest messages.");
      return false;
    }
    controller.enqueue(frame);
    return true;
  }

  function accept(event: GatewayDispatch) {
    if (closed || !eventMatches(event, stream)) return;
    const frame = encodeEvent(event.t, event.d);
    if (initialized) {
      enqueue(frame);
      return;
    }
    if (buffered.length >= dependencies.maxBufferEvents || bufferedBytes + frame.byteLength > dependencies.maxBufferBytes) {
      terminate("buffer_overflow", "Too many messages arrived while loading history. Reconnect for a new snapshot.");
      return;
    }
    buffered.push(frame);
    bufferedBytes += frame.byteLength;
  }

  async function initialize() {
    let stage: "gateway" | "history" = "gateway";
    try {
      if (stream.demo) {
        enqueue(encodeEvent("snapshot", {
          guild_id: stream.guildId, channel_id: stream.channelId, demo: true, messages: demoMessages(stream),
        }));
        initialized = true;
        return;
      }
      onCleanup(dependencies.gateway.subscribeStatus((status) => {
        if (status.type === "reset") terminate("gateway_reset", "The Discord session restarted. Reconnect for a new snapshot.");
        else if (status.type === "error") terminate("gateway_error", status.message ?? "The Discord connection failed.");
      }));
      if (closed) return;
      onCleanup(dependencies.gateway.subscribe(stream.guildId, stream.channelId, accept));
      if (closed) return;
      await dependencies.gateway.waitUntilReady();
      if (closed) return;
      stage = "history";
      const messages = await dependencies.history(stream.channelId, abort.signal);
      if (closed) return;
      // Discord's REST response is newest first. Leave each raw message untouched.
      if (!enqueue(encodeEvent("snapshot", {
        guild_id: stream.guildId, channel_id: stream.channelId, messages: messages.slice(0, 50).reverse(),
      }))) return;
      initialized = true;
      for (const frame of buffered) if (!enqueue(frame)) break;
      buffered = [];
      bufferedBytes = 0;
    } catch (error) {
      if (closed) return;
      terminate(stage === "history" ? "history_error" : "gateway_error", error instanceof Error ? error.message : "Could not connect to Discord.");
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      if (request.signal.aborted) {
        close();
        return;
      }
      const onAbort = () => close();
      request.signal.addEventListener("abort", onAbort, { once: true });
      onCleanup(() => request.signal.removeEventListener("abort", onAbort));
      onCleanup(dependencies.subscribeDeleted((deleted) => {
        if (closed || deleted.key !== stream.key) return;
        controller.enqueue(encodeEvent("stream_deleted", { guild_id: stream.guildId, channel_id: stream.channelId }));
        close();
      }));
      enqueue(encoder.encode("retry: 3000\n: connected\n\n"));
      if (closed) return;
      heartbeat = setInterval(() => enqueue(encoder.encode(": heartbeat\n\n")), dependencies.heartbeatMs);
      heartbeat.unref?.();
      void initialize();
    },
    cancel() {
      if (closed) return;
      closed = true;
      cleanup();
    },
  }, {
    highWaterMark: dependencies.maxQueueBytes,
    size: (chunk) => chunk?.byteLength ?? 0,
  });

  return new Response(body, {
    headers: { ...publicStreamHeaders, "Content-Type": "text/event-stream; charset=utf-8" },
  });
}
