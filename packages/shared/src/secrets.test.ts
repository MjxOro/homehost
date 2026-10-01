import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { containsSecret } from "./secrets.js";

const random = (n: number) => randomBytes(n).toString("base64url");
describe("secret guard", () => {
  test("blocks generated provider tokens, private keys and high entropy strings", () => {
    const values = [
      [random(18), random(4), random(32)].join("."),
      `${Math.floor(Math.random() * 1e9 + 1e8)}:${random(32)}`,
      `sk-${random(32)}`,
      `sk-or-v1-${randomBytes(32).toString("hex")}`,
      `ghp_${random(30)}`,
      `github_pat_${random(60)}`,
      `AKIA${randomBytes(8).toString("hex").toUpperCase()}`,
      `-----BEGIN PRIVATE KEY-----\n${random(60)}\n-----END PRIVATE KEY-----`,
      [
        Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
        random(18),
        random(32),
      ].join("."),
      random(96),
      randomBytes(32).toString("hex"),
    ];
    for (const value of values)
      expect(containsSecret(`please use ${value}`)).toBe(true);
  });
  test("accepts ordinary requests, addresses, ids and commands", () => {
    for (const text of [
      "a discord bot for my server",
      "Minecraft for five friends, 2 GB RAM please",
      "how do I log in? can you make it bigger?",
      "please make my website at https://example.com/my-project",
      "ssh root@my-server.bob.example.com",
      "docker compose up -d",
      randomUUID(),
      "I haven't got a token yet. Where do I get one?",
    ])
      expect(containsSecret(text)).toBe(false);
  });
  test("detects tokens next to punctuation and multiline private-key headers", () => {
    expect(
      containsSecret(`token=(${random(18)}.${random(4)}.${random(32)})`),
    ).toBe(true);
    expect(
      containsSecret("hello\n-----BEGIN RSA PRIVATE KEY-----\nplease help"),
    ).toBe(true);
  });
});
