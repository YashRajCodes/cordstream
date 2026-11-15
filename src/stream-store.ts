import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appUrl, streamDatabasePath } from "./config";

export type StoredStream = {
  key: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  createdAt: number;
  demo: boolean;
};

type StreamRow = {
  key: string;
  guild_id: string;
  channel_id: string;
  owner_id: string;
  created_at: number;
  demo: number;
};

function fromRow(row: StreamRow): StoredStream {
  return {
    key: row.key,
    guildId: row.guild_id,
    channelId: row.channel_id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    demo: Boolean(row.demo),
  };
}

export function publicStream(stream: StoredStream) {
  const url = new URL(`${appUrl.replace(/\/+$/, "")}/stream/${encodeURIComponent(stream.guildId)}/${encodeURIComponent(stream.channelId)}`);
  url.searchParams.set("key", stream.key);
  return {
    key: stream.key,
    guildId: stream.guildId,
    channelId: stream.channelId,
    createdAt: stream.createdAt,
    url: url.toString(),
  };
}

export class StreamStore {
  private db?: Database;
  private deletedListeners = new Set<(stream: StoredStream) => void>();

  constructor(private readonly path = streamDatabasePath) {}

  private database() {
    if (!this.db) {
      if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
      this.db = new Database(this.path, { create: true, strict: true });
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS streams (
          key TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          demo INTEGER NOT NULL CHECK (demo IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS streams_owner_channel
          ON streams (owner_id, guild_id, channel_id, demo);
      `);
    }
    return this.db;
  }

  create(input: Omit<StoredStream, "key" | "createdAt">): StoredStream {
    const stream = { ...input, key: crypto.randomUUID(), createdAt: Date.now() };
    this.database().query(`
      INSERT INTO streams (key, guild_id, channel_id, owner_id, created_at, demo)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(stream.key, stream.guildId, stream.channelId, stream.ownerId, stream.createdAt, Number(stream.demo));
    return stream;
  }

  list(ownerId: string, guildId: string, channelId: string, demo = false): StoredStream[] {
    return this.database().query<StreamRow, [string, string, string, number]>(`
      SELECT * FROM streams WHERE owner_id = ? AND guild_id = ? AND channel_id = ? AND demo = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(ownerId, guildId, channelId, Number(demo)).map(fromRow);
  }

  find(key: string, guildId: string, channelId: string): StoredStream | undefined {
    const row = this.database().query<StreamRow, [string, string, string]>(`
      SELECT * FROM streams WHERE key = ? AND guild_id = ? AND channel_id = ?
    `).get(key, guildId, channelId);
    return row ? fromRow(row) : undefined;
  }

  delete(key: string, ownerId: string, guildId: string, channelId: string, demo = false): boolean {
    const row = this.database().query<StreamRow, [string, string, string, string, number]>(`
      DELETE FROM streams WHERE key = ? AND owner_id = ? AND guild_id = ? AND channel_id = ? AND demo = ?
      RETURNING *
    `).get(key, ownerId, guildId, channelId, Number(demo));
    if (!row) return false;
    const stream = fromRow(row);
    for (const listener of this.deletedListeners) {
      try {
        listener(stream);
      } catch (error) {
        console.error("Could not notify a deleted stream subscriber", error);
      }
    }
    return true;
  }

  subscribeDeleted(listener: (stream: StoredStream) => void) {
    this.deletedListeners.add(listener);
    return () => { this.deletedListeners.delete(listener); };
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}

export const streamStore = new StreamStore();
