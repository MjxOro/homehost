// Exports the slice of @homehost/shared the Go worker consumes, plus parity
// vectors for the shared helpers it re-implements. Shared stays the single
// source of truth: run `bun run worker:contract` after changing plans,
// recipes, setup rules, stream profiles or the ported helpers, and commit the
// regenerated files. CI fails when they are stale.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MINECRAFT_PORT,
  PLANS,
  RECIPES,
  SETUP_EXIT_CODES,
  SETUP_STEP_ATTEMPTS,
  SETUP_STEP_DEFAULT_ERROR,
  SETUP_STEP_IDS,
  SETUP_TRANSIENT_OUTPUT,
  STREAM_PROFILES,
  dohHasAaaa,
  gameAddressOf,
  ipv6ForInstance,
  isTransientSetupFailure,
  normalizeIpv6,
  planSetup,
  sameIpv6,
  setupErrorOf,
  toDesktopHostname,
} from "../src/index.js";
import type { RecipeId, SetupErrorCode } from "../src/index.js";

const contractDir = join(
  import.meta.dir,
  "../../../apps/worker/internal/contract",
);

const recipeIds = Object.keys(RECIPES) as RecipeId[];

const contract = {
  plans: PLANS.map((plan) => ({
    id: plan.id,
    kind: plan.kind,
    image: plan.image,
    cpu: plan.cpu,
    memoryMb: plan.memoryMb,
    diskGb: plan.diskGb,
    desktop: plan.desktop ?? null,
  })),
  recipes: Object.fromEntries(
    recipeIds.map((id) => [
      id,
      { eula: RECIPES[id].eula, game: RECIPES[id].game },
    ]),
  ),
  // planSetup per stored recipe and plan, so the worker never re-derives
  // step lists, timeouts or the JVM heap.
  setupPlans: Object.fromEntries(
    recipeIds.map((id) => [
      id,
      Object.fromEntries(
        PLANS.map((plan) => [plan.id, planSetup(id, plan.memoryMb)]),
      ),
    ]),
  ),
  setupStepAttempts: SETUP_STEP_ATTEMPTS,
  setupExitCodes: SETUP_EXIT_CODES,
  setupStepDefaultError: SETUP_STEP_DEFAULT_ERROR,
  setupTransientOutput: SETUP_TRANSIENT_OUTPUT.map((pattern) => ({
    source: pattern.source,
    flags: pattern.flags,
  })),
  minecraftPort: MINECRAFT_PORT,
  streamProfiles: STREAM_PROFILES,
};

const requestIds = [
  "3f2c9a1e-7b4d-4c8e-9a10-5d6e7f809a1b",
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-00000000ffff",
  "00000000-0000-4000-8000-000000000003",
  "3F2C9A1E-7B4D-4C8E-9A10-5D6E7F809A1B",
  "not-a-uuid",
  "",
];
const prefixes = [
  "2001:db8:abcd:12",
  "2001:db8:abcd:12::",
  " 2001:db8:abcd:12:: ",
  "2001:DB8:ABCD:0012",
  "2001:db8::",
  "2001:db8:abcd:12:5",
  "",
  "bogus",
];

const ipv6Texts = [
  "2001:db8::1",
  "2001:0DB8:0000:0000:0000:0000:0000:0001",
  "::",
  "::1",
  "2001:db8::",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:7::",
  "1::2::3",
  "1:2:3:4:5:6:7:8:9",
  "12345::1",
  "::ffff:192.0.2.1",
  "fe80::1%eth0",
  "[2001:db8::1]",
  "  2001:db8::a  ",
  "",
  "g::1",
];

const dohBodies: unknown[] = [
  { Status: 0, Answer: [{ type: 28, data: "2001:db8::1" }] },
  { Status: 0, Answer: [{ type: 28, data: "2001:0db8::0001" }] },
  { Status: 0, Answer: [{ type: 28, data: "2001:db8::2" }] },
  { Status: 0, Answer: [{ type: 5, data: "2001:db8::1" }] },
  { Status: 0, Answer: [] },
  { Status: 0 },
  { Status: 3, Answer: [{ type: 28, data: "2001:db8::1" }] },
  { Status: "0", Answer: [{ type: 28, data: "2001:db8::1" }] },
  { Status: 0, Answer: [{ type: "28", data: "2001:db8::1" }] },
  { Status: 0, Answer: [null, { type: 28, data: "2001:db8::1" }] },
  { Status: 0, Answer: [{ type: 28, data: 42 }] },
  null,
  [],
  "text",
];

const setupErrorCases: Array<{ exitCode: number | null; timedOut: boolean }> = [
  { exitCode: 0, timedOut: true },
  { exitCode: null, timedOut: true },
  { exitCode: null, timedOut: false },
  { exitCode: 1, timedOut: false },
  { exitCode: 137, timedOut: false },
  ...Object.values(SETUP_EXIT_CODES).map((exitCode) => ({
    exitCode,
    timedOut: false,
  })),
];

const transientOutputs = [
  "E: Could not get lock /var/lib/dpkg/lock-frontend",
  "E: unable to acquire the dpkg frontend lock",
  "Temporary failure resolving 'archive.ubuntu.com'",
  "curl: (6) Could not resolve host: example.com",
  "curl: (28) Operation timed out",
  "curl: (22) The requested URL returned error: 404",
  "CURL: (7) failed",
  "W: Failed to fetch http://archive.ubuntu.com/",
  "Hash Sum mismatch",
  "connect: Network is unreachable",
  "read: Connection reset by peer",
  "ssh: Connection timed out",
  "E: Unable to locate package nope",
  "",
];

const setupErrorCodes = [
  ...new Set([
    ...Object.keys(SETUP_EXIT_CODES),
    ...Object.values(SETUP_STEP_DEFAULT_ERROR),
    "timeout",
    "unknown",
  ]),
] as SetupErrorCode[];

const vectors = {
  ipv6ForInstance: prefixes.flatMap((prefix) =>
    requestIds.map((requestId) => ({
      prefix,
      requestId,
      want: ipv6ForInstance(prefix, requestId),
    })),
  ),
  toDesktopHostname: [
    "box-alice-3f2c9a1e7b4d4c8e9a105d6e7f809a1b.homehost.risktozero.sh",
    "box-alice-3f2c9a1e7b4d4c8e9a105d6e7f809a1b.dev.homehost.risktozero.sh",
    "a".repeat(63) + ".example.test",
    "single-label",
    ".leading-dot.example",
    "",
  ].map((subdomain) => ({ subdomain, want: toDesktopHostname(subdomain) })),
  normalizeIpv6: ipv6Texts.map((input) => ({
    input,
    want: normalizeIpv6(input),
  })),
  sameIpv6: ipv6Texts.flatMap((a) =>
    ["2001:db8::1", "::", "bogus"].map((b) => ({
      a,
      b,
      want: sameIpv6(a, b),
    })),
  ),
  dohHasAaaa: dohBodies.map((body) => ({
    body,
    expected: "2001:db8::1",
    want: dohHasAaaa(body, "2001:db8::1"),
  })),
  setupErrorOf: SETUP_STEP_IDS.flatMap((step) =>
    setupErrorCases.map((run) => ({
      step,
      ...run,
      want: setupErrorOf(step, run),
    })),
  ),
  isTransientSetupFailure: setupErrorCodes.flatMap((error) =>
    transientOutputs.map((output) => ({
      error,
      output,
      want: isTransientSetupFailure(error, output),
    })),
  ),
  gameAddressOf: [...recipeIds, "unknown_recipe"].flatMap((recipeId) =>
    ["done", "running", "pending"].map((setupStatus) => ({
      recipeId,
      setupStatus,
      subdomain: "box.homehost.risktozero.sh",
      want: gameAddressOf({
        recipeId,
        setupStatus,
        subdomain: "box.homehost.risktozero.sh",
      }),
    })),
  ),
};

async function emit(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await emit(join(contractDir, "contract.json"), contract);
await emit(join(contractDir, "testdata", "vectors.json"), vectors);
