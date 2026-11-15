import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamStore } from "../src/stream-store";

describe("persistent stream links", () => {
  test("survives reopening the database and keeps channel/creator/demo records separate", () => {
    const directory = mkdtempSync(join(tmpdir(), "cordstream-store-"));
    const path = join(directory, "nested", "streams.sqlite");
    let store = new StreamStore(path);
    try {
      const input = { guildId: "guild", channelId: "channel", ownerId: "owner", demo: false };
      const first = store.create(input);
      const second = store.create(input);
      store.create({ ...input, demo: true });
      store.create({ ...input, ownerId: "someone-else" });
      store.create({ ...input, channelId: "another-channel" });
      expect(first.key).not.toBe(second.key);
      store.close();
      store = new StreamStore(path);
      expect(store.find(first.key, "guild", "channel")).toEqual(first);
      expect(store.find(first.key, "guild", "another-channel")).toBeUndefined();
      expect(store.find(first.key, "another-guild", "channel")).toBeUndefined();
      expect(store.list("owner", "guild", "channel")).toEqual([first, second]);
      expect(store.list("owner", "guild", "channel", true)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("only notifies successful revocations and stops notifying unsubscribed listeners", () => {
    const store = new StreamStore(":memory:");
    try {
      const stream = store.create({ guildId: "guild", channelId: "channel", ownerId: "owner", demo: false });
      const revoked: string[] = [];
      const unsubscribe = store.subscribeDeleted((item) => revoked.push(item.key));
      expect(store.delete(stream.key, "other-owner", "guild", "channel")).toBe(false);
      expect(store.delete(stream.key, "owner", "guild", "channel", true)).toBe(false);
      expect(revoked).toEqual([]);
      expect(store.delete(stream.key, "owner", "guild", "channel")).toBe(true);
      expect(store.find(stream.key, "guild", "channel")).toBeUndefined();
      expect(revoked).toEqual([stream.key]);
      expect(store.delete(stream.key, "owner", "guild", "channel")).toBe(false);
      unsubscribe();
      const second = store.create({ guildId: "guild", channelId: "channel", ownerId: "owner", demo: false });
      store.delete(second.key, "owner", "guild", "channel");
      expect(revoked).toEqual([stream.key]);
    } finally {
      store.close();
    }
  });
});
