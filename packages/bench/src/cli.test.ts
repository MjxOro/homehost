import { expect, test } from "bun:test";
import { main } from "./cli";

test("CLI rejects unknown commands/flags, malformed counts and unknown candidates before any network", async () => {
  for (const argv of [
    [],
    ["oops"],
    ["run", "--wat"],
    ["run"],
    ["run", "--candidate", "cheap", "--cache", "bad"],
    ["run", "--candidate", "cheap", "--repeats", "0"],
    ["run", "--candidate", "cheap", "--max-usd", "NaN"],
    ["run", "--candidate", "missing"],
  ]) {
    await expect(main(argv)).rejects.toBeInstanceOf(Error);
  }
});
