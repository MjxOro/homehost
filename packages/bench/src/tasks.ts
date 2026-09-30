import { readdir } from "node:fs/promises";
import { z } from "zod/v4";
import { SiteBrief } from "@homehost/sites";

export const PACKAGE_DIR = new URL("../", import.meta.url);

const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const Task = z.strictObject({
  id: Id,
  suite: z.literal("site-build"),
  tags: z.array(z.string().min(1)),
  brief: SiteBrief,
  expect: z.strictObject({
    requiredFacts: z.array(z.string().min(1)).optional(),
    forbidden: z.array(z.string().min(1)).optional(),
    minPages: z.number().int().min(1).max(8).optional(),
    maxPages: z.number().int().min(1).max(8).optional(),
  }),
});
export type Task = z.infer<typeof Task>;

export const Candidate = z.strictObject({
  id: Id,
  models: z.strictObject({
    plan: z.string().min(1),
    fill: z.string().min(1),
    escalate: z.string().min(1),
  }),
  concurrency: z.number().int().min(1).max(16).optional(),
  notes: z.string().optional(),
});
export type Candidate = z.infer<typeof Candidate>;

async function readJsonDir<T>(
  dir: URL,
  schema: z.ZodType<T>,
  idOf: (value: T) => string,
): Promise<T[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out: T[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = schema.safeParse(await Bun.file(new URL(file, dir)).json());
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(`${file}: ${issues}`);
    }
    const id = idOf(parsed.data);
    if (id !== file.replace(/\.json$/, ""))
      throw new Error(`${file}: id "${id}" must match the file name`);
    if (seen.has(id)) throw new Error(`${file}: duplicate id "${id}"`);
    seen.add(id);
    out.push(parsed.data);
  }
  return out;
}

export function loadAllTasks(suite = "site-build"): Promise<Task[]> {
  return readJsonDir(new URL(`tasks/${suite}/`, PACKAGE_DIR), Task, (t) => t.id);
}

export async function selectTasks(opts: {
  suite?: string;
  ids?: string[];
  limit?: number;
}): Promise<Task[]> {
  let tasks = await loadAllTasks(opts.suite);
  if (opts.ids) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    tasks = opts.ids.map((id) => {
      const task = byId.get(id);
      if (!task) throw new Error(`unknown task id "${id}"`);
      return task;
    });
  }
  return opts.limit === undefined ? tasks : tasks.slice(0, opts.limit);
}

export async function loadCandidate(id: string): Promise<Candidate> {
  if (!Id.safeParse(id).success) throw new Error(`invalid candidate id "${id}"`);
  const file = Bun.file(new URL(`candidates/${id}.json`, PACKAGE_DIR));
  if (!(await file.exists())) throw new Error(`unknown candidate "${id}"`);
  const parsed = Candidate.safeParse(await file.json());
  if (!parsed.success)
    throw new Error(
      `candidates/${id}.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  if (parsed.data.id !== id)
    throw new Error(`candidates/${id}.json: id must match the file name`);
  return parsed.data;
}
