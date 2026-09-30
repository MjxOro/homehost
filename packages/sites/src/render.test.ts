import { expect, test } from "bun:test";
import { renderSite, specFacts, findPlaceholders } from "./render";
import type { Section } from "./schema";
import { fixture } from "./fixtures.test-helper";

const baseUrl = "https://cedargroveplumbing.ca";
function allSections(): Section[] {
  return [
    {
      type: "hero.split-image",
      heading: "Care for your home",
      text: "From taps to drains",
      image: { src: "/images/home.jpg" },
      action: { label: "Services", href: "/services/" },
    },
    { type: "hero.centered", heading: "Local service", text: "Ready to help" },
    {
      type: "services.grid",
      heading: "Our services",
      items: [
        {
          title: "Repairs",
          description: "Leaks fixed",
          image: { src: "https://images.ca/repair.jpg" },
        },
      ],
    },
    { type: "about.text", heading: "Our story", text: "Family owned" },
    {
      type: "testimonials.cards",
      heading: "Neighbours say",
      items: [{ quote: "A careful repair", author: "Maya", detail: "Oak Bay" }],
    },
    {
      type: "gallery.grid",
      heading: "Recent work",
      images: [{ src: "/images/tap.jpg" }],
    },
    { type: "hours.table", heading: "When we work" },
    {
      type: "contact.details",
      heading: "Get in touch",
      text: "Tell us about your repair",
    },
    {
      type: "cta.banner",
      heading: "Book a visit",
      text: "Call our team",
      action: { label: "Contact", href: "#contact" },
    },
    {
      type: "faq.list",
      heading: "Questions",
      items: [{ question: "Do you quote first?", answer: "Always" }],
    },
    {
      type: "pricing.table",
      heading: "Rates",
      items: [
        { name: "Visit", price: "$120", description: "Includes inspection" },
      ],
    },
    {
      type: "team.cards",
      heading: "Meet us",
      items: [
        {
          name: "Ari",
          role: "Plumber",
          bio: "Ten years of experience",
          image: { src: "/images/ari.jpg" },
        },
      ],
    },
    { type: "map.embed", heading: "Find our shop" },
  ];
}
function catalogSite() {
  const spec = fixture();
  const sections = allSections();
  spec.pages[0]!.sections = sections.slice(0, 8);
  spec.pages.push({
    slug: "services",
    title: "Services",
    description: "Plumbing rates and our team",
    sections: sections.slice(8),
  });
  return spec;
}

test("rendering every catalog section is deterministic and does not mutate input", () => {
  const spec = catalogSite(),
    before = structuredClone(spec);
  const a = renderSite(spec, { baseUrl }),
    b = renderSite(spec, { baseUrl });
  expect([...a.files]).toEqual([...b.files]);
  expect(a.warnings).toEqual(b.warnings);
  expect(spec).toEqual(before);
  expect([...a.files.keys()]).toEqual([
    "index.html",
    "services/index.html",
    "styles.css",
    "sitemap.xml",
    "robots.txt",
  ]);
  for (const section of allSections())
    expect([...a.files.values()].join("\n")).toContain(section.heading);
});
test("text, attributes and JSON-LD resist HTML injection", () => {
  const spec = fixture();
  const attack =
    '</script><script>alert("owned")</script><img onerror="bad"> &';
  spec.business.name = attack;
  spec.business.address = attack;
  spec.pages[0]!.description = '" onload="bad"><script>bad</script>';
  spec.pages[0]!.sections = [
    {
      type: "hero.split-image",
      heading: attack,
      text: attack,
      image: { src: 'https://images.ca/a.jpg?q="bad"&x=1', alt: attack },
    },
  ];
  const html = renderSite(spec, { baseUrl }).files.get("index.html")!;
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&quot; onload=&quot;bad&quot;&gt;");
  expect(html).toContain('src="https://images.ca/a.jpg?q=%22bad%22&amp;x=1"');
  expect(html.match(/<script\b/g)).toHaveLength(1);
  expect(html).not.toMatch(/<[^>]+\son(?:error|load)="/);
  const data = JSON.parse(
    html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!,
  );
  expect(data.name).toBe(attack);
  expect(data.address).toBe(attack);
});
test("every page is linked in every navigation and has a canonical", () => {
  const spec = catalogSite();
  const files = renderSite(spec, { baseUrl }).files;
  for (const page of spec.pages) {
    const html = files.get(
      page.slug ? `${page.slug}/index.html` : "index.html",
    )!;
    const nav = html.match(/<nav\b[^>]*>(.*?)<\/nav>/s)![1]!;
    expect(nav).toContain('href="/"');
    expect(nav).toContain('href="/services/"');
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(
      `<link rel="canonical" href="${baseUrl}/${page.slug ? `${page.slug}/` : ""}">`,
    );
    expect(html).toContain('<html lang="en-CA">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('href="/styles.css"');
  }
});
test("sitemap and robots list absolute deployment URLs, including a base path", () => {
  const files = renderSite(catalogSite(), {
    baseUrl: `${baseUrl}/business`,
  }).files;
  expect(files.get("sitemap.xml")).toContain(`<loc>${baseUrl}/business/</loc>`);
  expect(files.get("sitemap.xml")).toContain(
    `<loc>${baseUrl}/business/services/</loc>`,
  );
  expect(files.get("robots.txt")).toContain(
    `Sitemap: ${baseUrl}/business/sitemap.xml`,
  );
  expect(files.get("index.html")).toContain('href="/business/styles.css"');
  expect(files.get("index.html")).toContain('href="/business/services/"');
});
test("JSON-LD parses with business phone, address, hours, area and socials", () => {
  const spec = fixture();
  const html = renderSite(spec, { baseUrl }).files.get("index.html")!;
  const data = JSON.parse(
    html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!,
  );
  expect(data["@type"]).toBe("LocalBusiness");
  expect(data.name).toBe(spec.business.name);
  expect(data.telephone).toBe(spec.business.phone);
  expect(data.address).toBe(spec.business.address);
  expect(data.areaServed).toEqual(spec.business.serviceArea);
  expect(data.sameAs).toEqual(
    spec.business.socials.map((social) => social.url),
  );
  expect(data.openingHoursSpecification[0].dayOfWeek[0]).toBe(
    "https://schema.org/Monday",
  );
  expect(data.openingHoursSpecification[0].opens).toBe("08:00");
});
test("tel and mailto links are derived from validated business details", () => {
  const html = renderSite(fixture(), { baseUrl }).files.get("index.html")!;
  expect(html).toContain('href="tel:+12505550147"');
  expect(html).toContain('href="mailto:hello%40cedargroveplumbing.ca"');
});
test("missing image alt uses context and produces a warning per image", () => {
  const output = renderSite(catalogSite(), { baseUrl });
  expect(output.warnings).toHaveLength(4);
  expect(output.files.get("index.html")).toContain(
    'alt="Care for your home — Cedar Grove Plumbing"',
  );
  expect(output.files.get("services/index.html")).toContain(
    'alt="Ari, Plumber — Cedar Grove Plumbing"',
  );
  const spec = fixture();
  spec.pages[0]!.sections = [
    {
      type: "gallery.grid",
      heading: "Work",
      images: [{ src: "/images/repair.jpg", alt: "Copper pipe repair" }],
    },
  ];
  const result = renderSite(spec, { baseUrl });
  expect(result.warnings).toHaveLength(0);
  expect(result.files.get("index.html")).toContain('alt="Copper pipe repair"');
});
test("map URL is built from the business address, and absent addresses warn", () => {
  const spec = fixture();
  spec.pages[0]!.sections = [{ type: "map.embed", heading: "Visit" }];
  const html = renderSite(spec, { baseUrl }).files.get("index.html")!;
  const encoded = new URLSearchParams({
    q: spec.business.address!,
    output: "embed",
  })
    .toString()
    .replaceAll("&", "&amp;");
  expect(html).toContain(`src="https://www.google.com/maps?${encoded}"`);
  delete spec.business.address;
  const output = renderSite(spec, { baseUrl });
  expect(output.warnings).toHaveLength(1);
  expect(output.files.get("index.html")).not.toContain("<iframe");
});
test("one h1 per page, unique section IDs, semantic tables and keyboard access", () => {
  const spec = catalogSite();
  spec.pages[1]!.sections.push(
    { type: "hours.table", heading: "Hours again" },
    { type: "hours.table", heading: "Hours twice" },
  );
  const output = renderSite(spec, { baseUrl });
  for (const [file, html] of output.files) {
    if (!file.endsWith(".html")) continue;
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('href="#main"');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  }
  const css = output.files.get("styles.css")!;
  expect(css).toContain(":focus-visible");
  expect(css).toContain("prefers-reduced-motion: reduce");
  expect(css).toContain("min-height: 44px");
  expect(css).not.toContain("@import");
});
test("required facts remain visible even without contact or hours sections", () => {
  const spec = fixture();
  const html = renderSite(spec, { baseUrl }).files.get("index.html")!;
  const visible = html.replace(/<head>.*?<\/head>/s, "");
  for (const fact of specFacts(spec)) expect(visible).toContain(fact);
});
test("flags each placeholder pattern regardless of case with the affected file", () => {
  expect(
    findPlaceholders(
      new Map([
        [
          "index.html",
          "LOREM Ipsum todo EXAMPLE.COM [Your name] XXX-XXXX lorem",
        ],
      ]),
    ),
  ).toEqual([
    { file: "index.html", placeholder: "lorem" },
    { file: "index.html", placeholder: "ipsum" },
    { file: "index.html", placeholder: "todo" },
    { file: "index.html", placeholder: "example.com" },
    { file: "index.html", placeholder: "[your" },
    { file: "index.html", placeholder: "xxx-xxxx" },
  ]);
});
test.each([
  "http://business.ca",
  "javascript:alert(1)",
  "https://user:pass@business.ca",
  "https://business.ca/?query=1",
  "https://business.ca/#fragment",
])("rejects invalid deployment URL %s", (url) => {
  expect(() => renderSite(fixture(), { baseUrl: url })).toThrow();
});
test("invalid specs cannot bypass URL validation at the rendering boundary", () => {
  const spec = fixture();
  spec.business.socials[0]!.url = "javascript:alert(1)";
  expect(() => renderSite(spec, { baseUrl })).toThrow("Invalid site spec");
});
