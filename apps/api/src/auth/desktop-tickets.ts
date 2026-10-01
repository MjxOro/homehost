import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const DESKTOP_TICKET_TTL_S = 8 * 60 * 60;
const Payload = z
  .object({
    requestId: z.string().uuid(),
    userId: z.string().min(1).max(128),
    exp: z.number().int().positive(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
export function createDesktopTickets(secret: string, now = Date.now) {
  const signature = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest();
  return {
    mint(requestId: string, userId: string) {
      const payload = Buffer.from(
        JSON.stringify(
          Payload.parse({
            requestId,
            userId,
            exp: Math.floor(now() / 1000) + DESKTOP_TICKET_TTL_S,
            nonce: randomBytes(16).toString("hex"),
          }),
        ),
      ).toString("base64url");
      return `${payload}.${signature(payload).toString("base64url")}`;
    },
    verify(ticket: string) {
      if (ticket.length > 700) return null;
      const parts = ticket.split(".");
      if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)))
        return null;
      const [payload, signed] = parts as [string, string];
      const received = Buffer.from(signed, "base64url");
      const expected = signature(payload);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        return null;
      try {
        const result = Payload.safeParse(
          JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        );
        if (!result.success || result.data.exp <= Math.floor(now() / 1000))
          return null;
        return result.data;
      } catch {
        return null;
      }
    },
  };
}
/** Bearer capabilities never belong in access logs. */
export function redactDesktopUrl(url: string) {
  try {
    const segments = url.split("/");
    if (
      segments.slice(0, 4).map(decodeURIComponent).join("/") ===
      "/api/desktop/t"
    )
      return "/api/desktop/t/[redacted]";
  } catch {
    // Invalid escape sequences cannot be a valid capability route.
  }
  return url;
}
