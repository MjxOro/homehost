import { expect, test } from "bun:test";
import { Task, loadAllTasks, loadCandidate, selectTasks } from "./tasks";

test("all thirty tasks validate, ids are unique, and corpus covers requested variations", async () => {
  const tasks = await loadAllTasks();
  expect(tasks).toHaveLength(30);
  expect(new Set(tasks.map((t) => t.id)).size).toBe(30);
  for (const task of tasks) expect(Task.safeParse(task).success).toBe(true);
  expect(new Set(tasks.map((t) => t.brief.niche)).size).toBeGreaterThanOrEqual(
    12,
  );
  expect(tasks.filter((t) => t.tags.includes("typos"))).toHaveLength(2);
  expect(tasks.filter((t) => t.tags.includes("french-canadian"))).toHaveLength(
    2,
  );
  expect(tasks.filter((t) => !t.brief.phone)).toHaveLength(1);
  expect(
    tasks.some((t) => t.expect.minPages === 6 && t.expect.maxPages === 6),
  ).toBe(true);
});
test("three candidates validate and single-model is a true ablation", async () => {
  expect((await loadCandidate("cheap")).models).toEqual({
    plan: "openai/gpt-oss-120b",
    fill: "google/gemini-2.5-flash-lite",
    escalate: "qwen/qwen3-235b-a22b-2507",
  });
  for (const id of ["cheap", "mid", "single-model"])
    expect((await loadCandidate(id)).id).toBe(id);
  expect(
    new Set(Object.values((await loadCandidate("single-model")).models)).size,
  ).toBe(1);
});
test("selection order and limits are stable; unknown, duplicate and traversing ids fail", async () => {
  const all = await loadAllTasks();
  expect((await selectTasks({ limit: 3 })).map((t) => t.id)).toEqual(
    all.slice(0, 3).map((t) => t.id),
  );
  expect(
    (await selectTasks({ ids: [all[1]!.id, all[0]!.id] })).map((t) => t.id),
  ).toEqual([all[1]!.id, all[0]!.id]);
  await expect(selectTasks({ ids: ["unknown"] })).rejects.toThrow(
    "unknown task",
  );
  await expect(selectTasks({ ids: [all[0]!.id, all[0]!.id] })).rejects.toThrow(
    "unique",
  );
  await expect(loadCandidate("../cheap")).rejects.toThrow("invalid candidate");
  expect(() => loadAllTasks("../..")).toThrow("unknown suite");
});
