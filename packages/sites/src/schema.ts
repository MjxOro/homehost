import { z } from "zod/v4";
import { FONT_PAIRINGS, THEME_PRESETS } from "./themes";

const text = (max: number) => z.string().min(1).max(max);
const httpsUrl = z.url().max(2048).regex(/^https:\/\//, "Use an HTTPS URL");
// Local references must start with one slash and contain no browser-normalized
// backslashes or control characters; protocol-relative URLs are not local.
const localPath = z.string().max(2048).regex(/^\/(?!\/)[a-zA-Z0-9/_.,~!$&'()*+;=:@%?#-]*$/);
const link = z.union([httpsUrl, localPath, z.string().max(100).regex(/^#[a-zA-Z][\w-]*$/)]);
const image = z.strictObject({ src: z.union([httpsUrl, localPath]), alt: text(300).optional() });
const action = z.strictObject({ label: text(80), href: link });
const heading = text(160);
const body = text(3000);

export const Section = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("hero.split-image"), heading, text: body, image, action: action.optional() }),
  z.strictObject({ type: z.literal("hero.centered"), heading, text: body, action: action.optional() }),
  z.strictObject({ type: z.literal("services.grid"), heading, items: z.array(z.strictObject({ title: text(120), description: text(1000), image: image.optional() })).min(1).max(12) }),
  z.strictObject({ type: z.literal("about.text"), heading, text: body }),
  z.strictObject({ type: z.literal("testimonials.cards"), heading, items: z.array(z.strictObject({ quote: text(1200), author: text(120), detail: text(160).optional() })).min(1).max(12) }),
  z.strictObject({ type: z.literal("gallery.grid"), heading, images: z.array(image).min(1).max(24) }),
  z.strictObject({ type: z.literal("hours.table"), heading }),
  z.strictObject({ type: z.literal("contact.details"), heading, text: body.optional() }),
  z.strictObject({ type: z.literal("cta.banner"), heading, text: body, action }),
  z.strictObject({ type: z.literal("faq.list"), heading, items: z.array(z.strictObject({ question: text(250), answer: text(2000) })).min(1).max(20) }),
  z.strictObject({ type: z.literal("pricing.table"), heading, items: z.array(z.strictObject({ name: text(120), price: text(80), description: text(1000) })).min(1).max(20) }),
  z.strictObject({ type: z.literal("team.cards"), heading, items: z.array(z.strictObject({ name: text(120), role: text(120), bio: text(1000).optional(), image: image.optional() })).min(1).max(12) }),
  z.strictObject({ type: z.literal("map.embed"), heading }),
]);
export type Section = z.infer<typeof Section>;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const time = z.string().max(5).regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const SiteSpec = z.strictObject({
  version: z.literal(1),
  business: z.strictObject({
    name: text(160), tagline: text(250).optional(), niche: text(120),
    phone: z.string().min(7).max(40).regex(/^\+?[\d ()-]+$/).refine((v) => v.replace(/\D/g, "").length >= 7, "Phone must contain at least seven digits").optional(),
    email: z.email().max(254).optional(), address: text(500).optional(),
    serviceArea: z.array(text(160)).max(30),
    hours: z.array(z.strictObject({ days: z.array(z.enum(DAYS)).min(1).max(7), opens: time, closes: time })).max(14),
    socials: z.array(z.strictObject({ kind: text(60), url: httpsUrl })).max(10),
  }),
  theme: z.strictObject({
    preset: z.enum(Object.keys(THEME_PRESETS) as [keyof typeof THEME_PRESETS, ...(keyof typeof THEME_PRESETS)[]]),
    fonts: z.enum(Object.keys(FONT_PAIRINGS) as [keyof typeof FONT_PAIRINGS, ...(keyof typeof FONT_PAIRINGS)[]]),
  }),
  pages: z.array(z.strictObject({
    slug: z.string().max(40).regex(/^[a-z0-9-]{0,40}$/), title: text(160), description: text(320),
    sections: z.array(Section).min(1).max(12),
  })).min(1).max(8),
}).superRefine((spec, ctx) => {
  if (spec.pages.filter((page) => page.slug === "").length !== 1) {
    ctx.addIssue({ code: "custom", path: ["pages"], message: "Exactly one home page (empty slug) is required" });
  }
  const seen = new Set<string>();
  spec.pages.forEach((page, i) => {
    if (seen.has(page.slug)) ctx.addIssue({ code: "custom", path: ["pages", i, "slug"], message: "Page slugs must be unique" });
    seen.add(page.slug);
  });
});
export type SiteSpec = z.infer<typeof SiteSpec>;
export type SpecIssue = { path: string; message: string };

export function validateSpec(input: unknown): { ok: true; spec: SiteSpec } | { ok: false; issues: SpecIssue[] } {
  const result = SiteSpec.safeParse(input);
  return result.success ? { ok: true, spec: result.data } : {
    ok: false, issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}

export function siteSpecJsonSchema(): object {
  return z.toJSONSchema(SiteSpec);
}
