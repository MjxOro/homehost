import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { PLANS, PortPool, toSubdomain } from "@homehost/shared";

export type ServerStatus = "provisioning" | "running" | "suspended" | "deleted";

export interface Server {
  id: string;
  ownerId: string;
  name: string;
  planId: string;
  status: ServerStatus;
  subdomain: string;
  port: number;
  createdAt: string;
}

const CreateServer = z.object({
  ownerId: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  planId: z.string().min(1),
  trusted: z.boolean().default(false),
});

const ServerParams = z.object({
  id: z.string().min(1),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  const servers = new Map<string, Server>();
  const ports = new PortPool();
  let seq = 0;

  app.get("/health", async () => ({ ok: true }));
  app.get("/plans", async () => PLANS);
  app.get("/servers", async () => [...servers.values()].filter((s) => s.status !== "deleted"));

  app.post("/servers", async (req, reply) => {
    const parsed = CreateServer.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { ownerId, name, planId, trusted } = parsed.data;

    const plan = PLANS.find((p) => p.id === planId);
    if (!plan) return reply.code(404).send({ error: "unknown plan" });
    if (plan.trustedOnly && !trusted) {
      return reply.code(403).send({ error: "plan requires trusted tier" });
    }
    const active = [...servers.values()].filter(
      (s) => s.ownerId === ownerId && s.status !== "deleted",
    ).length;
    if (active >= plan.maxServers) {
      return reply.code(429).send({ error: "server limit reached for plan" });
    }

    let port: number;
    try {
      port = ports.allocate();
    } catch {
      return reply.code(503).send({ error: "no game ports available" });
    }

    const server: Server = {
      id: `srv-${++seq}`,
      ownerId,
      name,
      planId,
      status: "provisioning",
      subdomain: toSubdomain(name, ownerId, process.env.BASE_DOMAIN ?? "lab.yourdomain.com"),
      port,
      createdAt: new Date().toISOString(),
    };
    servers.set(server.id, server);
    return reply.code(201).send(server);
  });

  app.delete("/servers/:id", async (req, reply) => {
    const params = ServerParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "bad id" });
    const server = servers.get(params.data.id);
    if (!server || server.status === "deleted") {
      return reply.code(404).send({ error: "not found" });
    }
    ports.release(server.port);
    server.status = "deleted";
    return { ok: true };
  });

  return app;
}
