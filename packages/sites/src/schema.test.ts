import { describe, expect, test } from "bun:test";
import { SiteSpec, Section, validateSpec, siteSpecJsonSchema } from "./schema";
import { FONT_PAIRINGS, THEME_PRESETS, contrastRatio } from "./themes";
import { fixture } from "./fixtures.test-helper";

describe("site spec validation", () => {
  test("accepts a complete spec", () => expect(validateSpec(fixture()).ok).toBe(true));
  test.each([
    ["long name", (s: SiteSpec) => { s.business.name = "a".repeat(161); }],
    ["long copy", (s: SiteSpec) => { s.pages[0]!.description = "a".repeat(321); }],
    ["bad slug", (s: SiteSpec) => { s.pages[0]!.slug = "../escape"; }],
    ["long slug", (s: SiteSpec) => { s.pages[0]!.slug = "a".repeat(41); }],
    ["duplicate slugs", (s: SiteSpec) => { s.pages.push(structuredClone(s.pages[0]!)); }],
    ["missing home", (s: SiteSpec) => { s.pages[0]!.slug = "services"; }],
    ["too many pages", (s: SiteSpec) => { s.pages.push(...Array.from({ length: 8 }, (_, i) => ({ ...s.pages[0]!, slug: `page-${i}` }))); }],
    ["too many sections", (s: SiteSpec) => { s.pages[0]!.sections = Array.from({ length: 13 }, () => s.pages[0]!.sections[0]!); }],
    ["javascript social", (s: SiteSpec) => { s.business.socials[0]!.url = "javascript:alert(1)"; }],
    ["HTTP social", (s: SiteSpec) => { s.business.socials[0]!.url = "http://business.ca"; }],
    ["bad hours", (s: SiteSpec) => { s.business.hours[0]!.opens = "25:00"; }],
    ["too many days", (s: SiteSpec) => { s.business.hours[0]!.days = Array(8).fill("mon"); }],
  ])("rejects %s", (_, mutate) => {
    const spec = fixture();
    mutate(spec);
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toEqual({ path: expect.any(String), message: expect.any(String) });
  });
  test.each(["javascript:alert(1)", "//evil.ca/a.jpg", "/\\evil.ca/a.jpg", "data:image/png,abc", "http://images.ca/a.jpg"])("rejects image URL %s", (src) => {
    expect(Section.safeParse({ type: "gallery.grid", heading: "Photos", images: [{ src }] }).success).toBe(false);
  });
  test("allows site-relative and HTTPS images", () => {
    expect(Section.safeParse({ type: "gallery.grid", heading: "Photos", images: [{ src: "/images/shop.jpg" }, { src: "https://images.ca/shop.jpg" }] }).success).toBe(true);
  });
  test("rejects free-text map URLs and unsafe CTA links", () => {
    expect(Section.safeParse({ type: "map.embed", heading: "Visit", url: "https://maps.ca" }).success).toBe(false);
    expect(Section.safeParse({ type: "cta.banner", heading: "Call", text: "Today", action: { label: "Call", href: "tel:123" } }).success).toBe(false);
  });
  test("JSON Schema round-trips and contains every catalog type and bounded collection", () => {
    const schema = JSON.parse(JSON.stringify(siteSpecJsonSchema()));
    expect(schema.type).toBe("object");
    expect(schema.properties.pages.maxItems).toBe(8);
    expect(schema.properties.pages.items.properties.sections.maxItems).toBe(12);
    const catalog = schema.properties.pages.items.properties.sections.items.anyOf;
    expect(catalog.map((item: any) => item.properties.type.const).sort()).toEqual(Section.options.map((option) => option.shape.type.value).sort());
    // Enumerations and constants are intrinsically bounded; all free text and arrays
    // must explicitly have limits, including fields nested in section variants.
    function check(node: any): void {
      if (!node || typeof node !== "object") return;
      if (node.type === "string" && !node.enum && node.const === undefined) expect(node.maxLength).toBeNumber();
      if (node.type === "array") expect(node.maxItems).toBeNumber();
      Object.values(node).forEach((child) => { if (Array.isArray(child)) child.forEach(check); else check(child); });
    }
    check(schema);
  });
});

test("every theme has readable text and buttons", () => {
  expect(Object.keys(THEME_PRESETS).length).toBeGreaterThanOrEqual(8);
  expect(Object.keys(FONT_PAIRINGS).length).toBeGreaterThanOrEqual(5);
  for (const theme of Object.values(THEME_PRESETS)) {
    expect(contrastRatio(theme.text, theme.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.primaryText, theme.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.muted, theme.bg)).toBeGreaterThanOrEqual(4.5);
  }
});
