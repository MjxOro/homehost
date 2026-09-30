import { expect, test } from "bun:test";
import { join } from "node:path";
import { withCache, CacheMiss, type CachedResponse } from "./cache";
import { hashLlmRequest } from "./pipeline";
import { request, response, temporary } from "./fixtures.test-helper";

test("record/replay round-trips full response, bigint and original latency without network", async () => {
  const temp = await temporary();
  try {
    let calls = 0;
    const original = response(9007199254740993n);
    const recorded = withCache(
      {
        complete: async () => {
          calls++;
          return original;
        },
      },
      { dir: temp.dir, mode: "record" },
    );
    expect(
      ((await recorded.complete(request)) as CachedResponse).cacheStatus,
    ).toBe("live");
    const replay = withCache(
      {
        complete: async () => {
          throw new Error("No network");
        },
      },
      { dir: temp.dir, mode: "replay" },
    );
    const result = (await replay.complete(request)) as CachedResponse;
    expect(result).toEqual({ ...original, cacheStatus: "hit" });
    expect(
      ((await recorded.complete(request)) as CachedResponse).cacheStatus,
    ).toBe("hit");
    expect(calls).toBe(1);
    const stored = await Bun.file(
      join(temp.dir, `${hashLlmRequest(request)}.json`),
    ).json();
    expect(stored.response.usage.costMicroUsd).toBe("9007199254740993");
  } finally {
    await temp.cleanup();
  }
});

test("replay miss names exact request hash and never calls through", async () => {
  const temp = await temporary();
  try {
    const client = withCache(
      {
        complete: async () => {
          throw new Error("Should not run");
        },
      },
      { dir: temp.dir, mode: "replay" },
    );
    await expect(client.complete(request)).rejects.toBeInstanceOf(CacheMiss);
    await expect(client.complete(request)).rejects.toThrow(
      hashLlmRequest(request),
    );
  } finally {
    await temp.cleanup();
  }
});

test("live bypasses disk; corrupted or wrong-key cache cannot silently replay", async () => {
  const temp = await temporary();
  try {
    const path = join(temp.dir, `${hashLlmRequest(request)}.json`);
    const client = { complete: async () => response() };
    await withCache(client, { dir: temp.dir, mode: "live" }).complete(request);
    expect(await Bun.file(path).exists()).toBe(false);
    await withCache(client, { dir: temp.dir, mode: "record" }).complete(
      request,
    );
    const stored = await Bun.file(path).json();
    stored.key = "wrong";
    await Bun.write(path, JSON.stringify(stored));
    await expect(
      withCache(client, { dir: temp.dir, mode: "replay" }).complete(request),
    ).rejects.toThrow("key mismatch");
  } finally {
    await temp.cleanup();
  }
});
