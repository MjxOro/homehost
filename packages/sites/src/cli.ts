import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderSite } from "./render";
import { validateSpec } from "./schema";

export async function runCli(args: string[]): Promise<number> {
  if (
    args[0] !== "render" ||
    (args.length !== 3 && args.length !== 5) ||
    (args.length === 5 && args[3] !== "--base-url")
  ) {
    console.error(
      "Usage: bun packages/sites/src/cli.ts render <spec.json> <outDir> [--base-url https://…]",
    );
    return 1;
  }
  try {
    const input: unknown = await Bun.file(resolve(args[1]!)).json();
    const validation = validateSpec(input);
    if (!validation.ok) {
      for (const issue of validation.issues)
        console.error(`${issue.path || "spec"}: ${issue.message}`);
      return 1;
    }
    const output = renderSite(validation.spec, {
      baseUrl: args[4] ?? "https://localhost",
    });
    const outDir = resolve(args[2]!);
    for (const [path, content] of output.files) {
      const target = resolve(outDir, path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }
    for (const warning of output.warnings) console.warn(`Warning: ${warning}`);
    console.log(
      `Rendered ${validation.spec.pages.length} pages (${output.files.size} files) to ${outDir}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2));
