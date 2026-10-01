import { describe, expect, test } from "bun:test";
import { RECIPES, RECIPE_IDS } from "./concierge-catalog.js";
import { PLANS } from "./plans.js";
import {
  SETUP_EXIT_CODES,
  gameAddressOf,
  isTransientSetupFailure,
  minecraftHeapMb,
  planSetup,
  recipeRequestProblem,
  setupErrorOf,
} from "./setup.js";

const container = PLANS.find((p) => p.kind === "container")!;
const vm = PLANS.find((p) => p.kind === "vm" && !p.desktop)!;

describe("recipe request validation", () => {
  test("plain Ubuntu is always allowed", () => {
    expect(recipeRequestProblem(container, undefined, undefined)).toBeNull();
    expect(recipeRequestProblem(container, "none", undefined)).toBeNull();
  });

  test("coming-soon recipes cannot be requested", () => {
    for (const id of RECIPE_IDS) {
      if (RECIPES[id].installable) continue;
      expect(recipeRequestProblem(vm, id, true)).not.toBeNull();
    }
  });

  test("VM-only recipes are refused on a container plan only", () => {
    expect(recipeRequestProblem(container, "docker", undefined)).not.toBeNull();
    expect(recipeRequestProblem(vm, "docker", undefined)).toBeNull();
  });

  test("a recipe with a EULA needs explicit acceptance", () => {
    expect(
      recipeRequestProblem(container, "minecraft_java", undefined),
    ).not.toBeNull();
    expect(
      recipeRequestProblem(container, "minecraft_java", false),
    ).not.toBeNull();
    expect(recipeRequestProblem(container, "minecraft_java", true)).toBeNull();
  });
});

describe("game address", () => {
  const subdomain = "mc.alice.homehost.example";
  test("only a finished game recipe has an address", () => {
    expect(
      gameAddressOf({
        recipeId: "minecraft_java",
        setupStatus: "done",
        subdomain,
      }),
    ).toBe(subdomain);
    for (const setupStatus of ["pending", "running", "failed"]) {
      expect(
        gameAddressOf({ recipeId: "minecraft_java", setupStatus, subdomain }),
      ).toBeNull();
    }
    expect(
      gameAddressOf({ recipeId: "node", setupStatus: "done", subdomain }),
    ).toBeNull();
    expect(
      gameAddressOf({ recipeId: null, setupStatus: "none", subdomain }),
    ).toBeNull();
  });

  test("ids outside the catalog never resolve, even prototype keys", () => {
    for (const recipeId of ["toString", "constructor", "minecraft"]) {
      expect(gameAddressOf({ recipeId, setupStatus: "done", subdomain })).toBe(
        null,
      );
      expect(planSetup(recipeId, 4096)).toBeNull();
    }
  });
});

describe("minecraft heap", () => {
  test("plan memory minus the OS reserve, never below 1024 MB", () => {
    expect(minecraftHeapMb(2048)).toBe(1536);
    expect(minecraftHeapMb(8192)).toBe(7680);
    expect(minecraftHeapMb(1536)).toBe(1024);
    expect(minecraftHeapMb(1024)).toBe(1024);
    expect(minecraftHeapMb(512)).toBe(1024);
  });
});

describe("setup planning", () => {
  test("runs the catalog steps in order with a heap only for Java", () => {
    const mc = planSetup("minecraft_java", container.memoryMb)!;
    expect(mc.steps.map((s) => s.id)).toEqual([
      ...RECIPES.minecraft_java.steps,
    ]);
    expect(mc.heapMb).toBe(minecraftHeapMb(container.memoryMb));
    expect(mc.steps.at(-1)?.id).toBe("wait_ready");
    const node = planSetup("node", container.memoryMb)!;
    expect(node.steps.map((s) => s.id)).toEqual([...RECIPES.node.steps]);
    expect(node.heapMb).toBeNull();
  });

  test("every installable recipe with steps has a plan with positive timeouts", () => {
    for (const id of RECIPE_IDS) {
      const plan = planSetup(id, 2048);
      if (!RECIPES[id].installable || RECIPES[id].steps.length === 0) {
        expect(plan).toBeNull();
        continue;
      }
      expect(plan!.steps.length).toBe(RECIPES[id].steps.length);
      for (const step of plan!.steps) expect(step.timeoutMs).toBeGreaterThan(0);
    }
  });

  test("wait_ready outlasts the in-box five minute port wait", () => {
    const wait = planSetup("minecraft_java", 2048)!.steps.find(
      (s) => s.id === "wait_ready",
    )!;
    expect(wait.timeoutMs).toBeGreaterThan(5 * 60_000);
  });
});

describe("setup error codes", () => {
  test("a timeout wins over any exit code", () => {
    expect(
      setupErrorOf("download_minecraft", {
        exitCode: SETUP_EXIT_CODES.checksum_mismatch,
        timedOut: true,
      }),
    ).toBe("timeout");
  });

  test("script exit codes name their failure on any step", () => {
    for (const [code, exitCode] of Object.entries(SETUP_EXIT_CODES)) {
      expect(
        setupErrorOf("configure_minecraft", { exitCode, timedOut: false }),
      ).toBe(code as keyof typeof SETUP_EXIT_CODES);
    }
  });

  test("unnamed failures fall back to the step's kind of work", () => {
    const failed = { exitCode: 1, timedOut: false };
    expect(setupErrorOf("update_packages", failed)).toBe("apt_failed");
    expect(setupErrorOf("install_docker", failed)).toBe("apt_failed");
    expect(setupErrorOf("download_minecraft", failed)).toBe("download_failed");
    expect(setupErrorOf("start_service", failed)).toBe("service_failed");
    expect(setupErrorOf("wait_ready", failed)).toBe("not_ready");
    expect(setupErrorOf("configure_minecraft", failed)).toBe("unknown");
    expect(
      setupErrorOf("install_java", { exitCode: null, timedOut: false }),
    ).toBe("apt_failed");
  });

  test("apt locks and network blips are retried; real failures are not", () => {
    expect(
      isTransientSetupFailure(
        "apt_failed",
        "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 812",
      ),
    ).toBe(true);
    expect(
      isTransientSetupFailure(
        "download_failed",
        "curl: (6) Could not resolve host: piston-meta.mojang.com",
      ),
    ).toBe(true);
    expect(
      isTransientSetupFailure(
        "apt_failed",
        "E: Unable to locate package openjdk-21-jre-headless",
      ),
    ).toBe(false);
    expect(
      isTransientSetupFailure("checksum_mismatch", "Connection timed out"),
    ).toBe(false);
    expect(isTransientSetupFailure("timeout", "Failed to fetch")).toBe(false);
  });
});
