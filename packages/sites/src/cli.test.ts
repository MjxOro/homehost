import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixtures.test-helper";
import { renderSite } from "./render";

async function cli(args: string[]) {
  const process = Bun.spawn(
    [Bun.which("bun")!, join(import.meta.dir, "cli.ts"), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("CLI writes renderer bytes and prints alt warnings", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../.cli-test-"));
  try {
    const spec = fixture();
    spec.pages[0]!.sections = [
      {
        type: "gallery.grid",
        heading: "Repairs",
        images: [{ src: "/images/pipe.jpg" }],
      },
    ];
    const input = join(dir, "spec.json"),
      output = join(dir, "out");
    await Bun.write(input, JSON.stringify(spec));
    const result = await cli([
      "render",
      input,
      output,
      "--base-url",
      "https://cedargroveplumbing.ca",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Rendered 1 pages (4 files)");
    expect(result.stderr).toContain(
      "Warning: home/sections/0/images/0: missing image alt",
    );
    for (const [path, content] of renderSite(spec, {
      baseUrl: "https://cedargroveplumbing.ca",
    }).files)
      expect(await Bun.file(join(output, path)).text()).toBe(content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects invalid spec with field issues before writing output", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../.cli-test-"));
  try {
    const spec = fixture();
    spec.business.name = "a".repeat(161);
    const input = join(dir, "invalid.json"),
      output = join(dir, "out");
    await Bun.write(input, JSON.stringify(spec));
    const result = await cli(["render", input, output]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("business.name:");
    expect(
      await stat(output).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(
  [
    [],
    ["other"],
    ["render", "a.json", "out", "--wrong", "https://business.ca"],
    ["render", "a.json", "out", "--base-url"],
  ].map((args) => ({ args })),
)("CLI exits 1 and prints usage for invalid arguments %j", async ({ args }) => {
  const result = await cli(args);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Usage:");
});

test("CLI reports unreadable inputs", async () => {
  const result = await cli([
    "render",
    join(import.meta.dir, "file-that-does-not-exist.json"),
    join(import.meta.dir, "../.unused-out"),
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("ENOENT");
});
