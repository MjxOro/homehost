import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { ApiEnv, OAuthProviderConfig } from "../env.js";
import {
  clearStateCookieHeader,
  getStateCookie,
  sessionCookie,
  SESSION_MAX_AGE_S,
  stateCookie,
} from "./cookies.js";

const ProviderParams = z.object({ provider: z.enum(["google", "github"]) });
const CallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

interface ProviderDef {
  authorize: string;
  token: string;
  scope: string;
}

const PROVIDERS: Record<"google" | "github", ProviderDef> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
};

interface VerifiedProfile {
  sub: string;
  email: string;
  name: string;
}

function sendErr(
  reply: FastifyReply,
  status: number,
  error: string,
  code: string,
) {
  return reply.code(status).send({ error, code });
}

function configFor(
  env: ApiEnv,
  provider: "google" | "github",
): OAuthProviderConfig | null {
  return provider === "google" ? env.google : env.github;
}

function redirectUri(appOrigin: string, provider: string): string {
  return `${appOrigin}/api/auth/callback/${provider}`;
}

async function exchangeCode(
  provider: "google" | "github",
  config: OAuthProviderConfig,
  code: string,
  redirect: string,
): Promise<string> {
  const response = await fetch(PROVIDERS[provider].token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok)
    throw new Error(`token exchange failed: ${response.status}`);
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("token exchange returned no access token");
  }
  return body.access_token;
}

async function fetchProfile(
  provider: "google" | "github",
  accessToken: string,
): Promise<VerifiedProfile> {
  if (provider === "google") {
    const response = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok) throw new Error(`userinfo failed: ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.sub !== "string" || typeof body.email !== "string") {
      throw new Error("userinfo missing sub/email");
    }
    if (body.email_verified !== true) throw new Error("email not verified");
    const name =
      typeof body.name === "string" && body.name ? body.name : body.email;
    return { sub: body.sub, email: body.email.toLowerCase(), name };
  }
  const me = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!me.ok) throw new Error(`github user failed: ${me.status}`);
  const profile = (await me.json()) as Record<string, unknown>;
  if (typeof profile.id !== "number" && typeof profile.id !== "string") {
    throw new Error("github user missing id");
  }
  const sub = String(profile.id);
  let email: string | null =
    typeof profile.email === "string" ? profile.email.toLowerCase() : null;
  if (!email) {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) throw new Error(`github emails failed: ${res.status}`);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    const primary = list.find((e) => e.primary === true && e.verified === true);
    if (!primary || typeof primary.email !== "string") {
      throw new Error("no verified github email");
    }
    email = primary.email.toLowerCase();
  }
  const login = typeof profile.login === "string" ? profile.login : null;
  const name =
    (typeof profile.name === "string" && profile.name) || login || email;
  return { sub, email, name };
}

export function registerOAuth(
  app: FastifyInstance,
  db: Database,
  env: ApiEnv,
): void {
  if (!env.google && !env.github) return;

  app.get<{ Params: { provider: string } }>(
    "/api/auth/:provider",
    async (req, reply) => {
      const params = ProviderParams.safeParse(req.params);
      if (!params.success)
        return sendErr(reply, 404, "unknown provider", "not_found");
      const config = configFor(env, params.data.provider);
      if (!config)
        return sendErr(reply, 404, "provider not configured", "not_found");
      const def = PROVIDERS[params.data.provider];
      const state = randomBytes(16).toString("hex");
      reply.header("Set-Cookie", stateCookie(state));
      const url = new URL(def.authorize);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set(
        "redirect_uri",
        redirectUri(env.appOrigin, params.data.provider),
      );
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", def.scope);
      url.searchParams.set("state", state);
      return reply.redirect(url.toString());
    },
  );

  app.get<{ Params: { provider: string } }>(
    "/api/auth/callback/:provider",
    async (req, reply) => {
      const params = ProviderParams.safeParse(req.params);
      const query = CallbackQuery.safeParse(req.query);
      if (!params.success || !query.success) {
        return sendErr(reply, 400, "invalid callback", "invalid");
      }
      const config = configFor(env, params.data.provider);
      if (!config)
        return sendErr(reply, 404, "provider not configured", "not_found");
      const expected = getStateCookie(req);
      reply.header("Set-Cookie", clearStateCookieHeader());
      const a = Buffer.from(query.data.state);
      const b = Buffer.from(expected ?? "");
      if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
        return sendErr(reply, 400, "state mismatch", "invalid");
      }
      let profile: VerifiedProfile;
      try {
        const token = await exchangeCode(
          params.data.provider,
          config,
          query.data.code,
          redirectUri(env.appOrigin, params.data.provider),
        );
        profile = await fetchProfile(params.data.provider, token);
      } catch (e) {
        const message = e instanceof Error ? e.message : "login failed";
        return sendErr(reply, 403, message, "forbidden");
      }
      const user = await db.transaction(async (tx) => {
        // OPERATOR_EMAILS is the source of truth; reconcile on every login so
        // allowlist additions grant and removals revoke operator on next login.
        const isOperator = env.operatorEmails.includes(profile.email);
        const expectedRole = isOperator ? "operator" : "member";
        const bySub = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.provider, params.data.provider))
          .limit(100);
        const linked = bySub.find((u) => u.providerSub === profile.sub);
        if (linked && linked.role !== expectedRole) {
          const reconciled = await tx
            .update(schema.users)
            .set({ role: expectedRole })
            .where(eq(schema.users.id, linked.id))
            .returning();
          return reconciled[0];
        }
        if (linked) return linked;
        const byEmail = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, profile.email))
          .limit(1);
        if (byEmail.length > 0) {
          const updated = await tx
            .update(schema.users)
            .set({
              provider: params.data.provider,
              providerSub: profile.sub,
              name: profile.name,
              role: expectedRole,
            })
            .where(eq(schema.users.id, byEmail[0].id))
            .returning();
          return updated[0];
        }
        // (isOperator declared at the top of this transaction.)
        let tier: "technical" | "nontechnical" = "nontechnical";
        if (isOperator) {
          tier = "technical";
        } else {
          const invite = await tx
            .select()
            .from(schema.invites)
            .where(eq(schema.invites.email, profile.email))
            .limit(1);
          if (invite.length > 0 && !invite[0].usedAt) {
            tier = invite[0].tier as "technical" | "nontechnical";
            await tx
              .update(schema.invites)
              .set({ usedAt: new Date() })
              .where(eq(schema.invites.id, invite[0].id));
          }
        }
        const inserted = await tx
          .insert(schema.users)
          .values({
            id: `u-${randomBytes(4).toString("hex")}`,
            name: profile.name,
            email: profile.email,
            provider: params.data.provider,
            providerSub: profile.sub,
            role: isOperator ? "operator" : "member",
            tier,
          })
          .returning();
        return inserted[0];
      });
      const token = randomBytes(32).toString("hex");
      await db.insert(schema.sessions).values({
        tokenHash: createHash("sha256").update(token).digest("hex"),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_MAX_AGE_S * 1000),
      });
      reply.header("Set-Cookie", sessionCookie(token));
      return reply.redirect(`${env.appOrigin}/`);
    },
  );
}
