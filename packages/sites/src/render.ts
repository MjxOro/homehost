import { validateSpec, type SiteSpec } from "./schema";
import { styles } from "./styles";

const dayNames = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
} as const;
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
const paragraph = (value: string) => `<p class="copy">${escapeHtml(value)}</p>`;
const button = (action: { label: string; href: string }) =>
  `<a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
const phoneHref = (phone: string) => `tel:${phone.replace(/[^+\d]/g, "")}`;

function hoursTable(business: SiteSpec["business"]): string {
  if (!business.hours.length)
    return paragraph("Contact us for current opening hours.");
  return `<table><caption>Opening hours</caption><thead><tr><th scope="col">Days</th><th scope="col">Hours</th></tr></thead><tbody>${business.hours.map((hours) => `<tr><th scope="row">${hours.days.map((day) => dayNames[day]).join(", ")}</th><td><time>${hours.opens}</time>–<time>${hours.closes}</time></td></tr>`).join("")}</tbody></table>`;
}

function contactDetails(business: SiteSpec["business"]): string {
  return [
    business.phone
      ? `<p><a class="contact-link" href="${escapeHtml(phoneHref(business.phone))}">${escapeHtml(business.phone)}</a></p>`
      : "",
    business.email
      ? `<p><a class="contact-link" href="mailto:${escapeHtml(encodeURIComponent(business.email))}">${escapeHtml(business.email)}</a></p>`
      : "",
    business.address
      ? `<address>${escapeHtml(business.address)}</address>`
      : "",
    business.serviceArea.length
      ? `<p>Serving ${business.serviceArea.map(escapeHtml).join(", ")}</p>`
      : "",
    business.socials.length
      ? `<div class="socials">${business.socials.map((social) => `<a href="${escapeHtml(social.url)}">${escapeHtml(social.kind)}</a>`).join("")}</div>`
      : "",
  ].join("");
}

/** Script data is JSON, not HTML text: Unicode-escape markup delimiters. */
function jsonLd(spec: SiteSpec, url: string): string {
  const b = spec.business;
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: b.name,
    url,
    description: b.tagline ?? b.niche,
    telephone: b.phone,
    email: b.email,
    address: b.address,
    openingHoursSpecification: b.hours.map((hours) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: hours.days.map((day) => `https://schema.org/${dayNames[day]}`),
      opens: hours.opens,
      closes: hours.closes,
    })),
    areaServed: b.serviceArea,
    sameAs: b.socials.map((social) => social.url),
  }).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderSite(
  input: SiteSpec,
  opts: { baseUrl: string },
): { files: Map<string, string>; warnings: string[] } {
  const validation = validateSpec(input);
  if (!validation.ok)
    throw new Error(
      `Invalid site spec: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  const spec = validation.spec;
  const base = new URL(opts.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "baseUrl must be an HTTPS URL without credentials, query or fragment",
    );
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const pagePath = (slug: string) =>
    `${base.pathname}${slug ? `${slug}/` : ""}`;
  const pageUrl = (slug: string) => new URL(pagePath(slug), base).href;
  const warnings: string[] = [],
    files = new Map<string, string>();

  for (const page of spec.pages) {
    const imageHtml = (
      image: { src: string; alt?: string },
      context: string,
      position: string,
      eager = false,
    ) => {
      const alt = image.alt ?? `${context} — ${spec.business.name}`;
      if (image.alt === undefined)
        warnings.push(
          `${page.slug || "home"}/${position}: missing image alt; using "${alt}"`,
        );
      return `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(alt)}" loading="${eager ? "eager" : "lazy"}" decoding="async" width="800" height="600">`;
    };
    const firstHero = page.sections.findIndex((section) =>
      section.type.startsWith("hero."),
    );
    const ids = new Map<string, number>();
    const sectionHtml = page.sections
      .map((section, index) => {
        const kind = section.type.split(".")[0]!;
        const count = (ids.get(kind) ?? 0) + 1;
        ids.set(kind, count);
        const id = `${kind}${count > 1 ? `-${count}` : ""}`;
        const tag = index === firstHero ? "h1" : "h2";
        const heading = `<${tag}>${escapeHtml(section.heading)}</${tag}>`;
        const photo = (
          image: { src: string; alt?: string },
          context: string,
          suffix: string,
          eager = false,
        ) => imageHtml(image, context, `sections/${index}/${suffix}`, eager);
        let content: string,
          className = "";
        switch (section.type) {
          case "hero.split-image":
            className = "hero";
            content = `<div class="split"><div>${heading}${paragraph(section.text)}${section.action ? button(section.action) : ""}</div>${photo(section.image, section.heading, "image", index === firstHero)}</div>`;
            break;
          case "hero.centered":
            className = "hero hero-centered";
            content = `${heading}${paragraph(section.text)}${section.action ? button(section.action) : ""}`;
            break;
          case "services.grid":
            content = `${heading}<div class="grid">${section.items.map((item, i) => `<article class="card">${item.image ? photo(item.image, item.title, `items/${i}/image`) : ""}<h3>${escapeHtml(item.title)}</h3>${paragraph(item.description)}</article>`).join("")}</div>`;
            break;
          case "about.text":
            content = heading + paragraph(section.text);
            break;
          case "testimonials.cards":
            content = `${heading}<div class="grid">${section.items.map((item) => `<blockquote class="card">${paragraph(item.quote)}<footer>${escapeHtml(item.author)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ""}</footer></blockquote>`).join("")}</div>`;
            break;
          case "gallery.grid":
            content = `${heading}<div class="grid">${section.images.map((image, i) => `<figure>${photo(image, `${section.heading}, photo ${i + 1}`, `images/${i}`)}</figure>`).join("")}</div>`;
            break;
          case "hours.table":
            content = heading + hoursTable(spec.business);
            break;
          case "contact.details":
            content =
              heading +
              (section.text ? paragraph(section.text) : "") +
              contactDetails(spec.business);
            break;
          case "cta.banner":
            className = "banner";
            content =
              heading + paragraph(section.text) + button(section.action);
            break;
          case "faq.list":
            content =
              heading +
              section.items
                .map(
                  (item) =>
                    `<details><summary>${escapeHtml(item.question)}</summary>${paragraph(item.answer)}</details>`,
                )
                .join("");
            break;
          case "pricing.table":
            content = `${heading}<table><caption>${escapeHtml(section.heading)}</caption><thead><tr><th scope="col">Service</th><th scope="col">Price</th><th scope="col">Details</th></tr></thead><tbody>${section.items.map((item) => `<tr><th scope="row">${escapeHtml(item.name)}</th><td>${escapeHtml(item.price)}</td><td>${escapeHtml(item.description)}</td></tr>`).join("")}</tbody></table>`;
            break;
          case "team.cards":
            content = `${heading}<div class="grid">${section.items.map((item, i) => `<article class="card">${item.image ? photo(item.image, `${item.name}, ${item.role}`, `items/${i}/image`) : ""}<h3>${escapeHtml(item.name)}</h3><p class="muted">${escapeHtml(item.role)}</p>${item.bio ? paragraph(item.bio) : ""}</article>`).join("")}</div>`;
            break;
          case "map.embed":
            if (spec.business.address) {
              const url = `https://www.google.com/maps?${new URLSearchParams({ q: spec.business.address, output: "embed" })}`;
              content = `${heading}<iframe src="${escapeHtml(url)}" title="${escapeHtml(`Map to ${spec.business.name}`)}" loading="lazy" height="360" referrerpolicy="no-referrer-when-downgrade"></iframe>${paragraph(spec.business.address)}`;
            } else {
              warnings.push(
                `${page.slug || "home"}/sections/${index}: map omitted because business.address is missing`,
              );
              content = heading + paragraph("Contact us for directions.");
            }
            break;
          default: {
            const unreachable: never = section;
            throw new Error(`Unknown section: ${unreachable}`);
          }
        }
        return `<section id="${id}"${className ? ` class="${className}"` : ""}><div class="wrap">${content}</div></section>`;
      })
      .join("\n");
    const title =
      page.title === spec.business.name
        ? page.title
        : `${page.title} | ${spec.business.name}`;
    const canonical = pageUrl(page.slug);
    const nav = spec.pages
      .map(
        (other) =>
          `<a href="${escapeHtml(pagePath(other.slug))}"${other.slug === page.slug ? ' aria-current="page"' : ""}>${escapeHtml(other.title)}</a>`,
      )
      .join("");
    files.set(
      page.slug ? `${page.slug}/index.html` : "index.html",
      `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="en_CA">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:site_name" content="${escapeHtml(spec.business.name)}">
<link rel="stylesheet" href="${escapeHtml(`${base.pathname}styles.css`)}">
<script type="application/ld+json">${jsonLd(spec, pageUrl(""))}</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap header-inner"><a class="brand" href="${escapeHtml(pagePath(""))}">${escapeHtml(spec.business.name)}</a><nav class="site-nav" aria-label="Main navigation">${nav}</nav></div></header>
<main id="main">${firstHero === -1 ? `<div class="wrap"><h1>${escapeHtml(page.title)}</h1></div>` : ""}
${sectionHtml}
</main>
<footer class="site-footer"><div class="wrap"><div class="grid"><div><h2>Contact</h2>${contactDetails(spec.business)}</div><div>${hoursTable(spec.business)}</div></div><p class="footer-name">${escapeHtml(spec.business.name)}${spec.business.tagline ? ` · ${escapeHtml(spec.business.tagline)}` : ""}</p></div></footer>
</body>
</html>
`,
    );
  }
  files.set("styles.css", styles(spec.theme));
  files.set(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${spec.pages.map((page) => `  <url><loc>${escapeHtml(pageUrl(page.slug))}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  files.set(
    "robots.txt",
    `User-agent: *\nAllow: /\nSitemap: ${new URL("sitemap.xml", base).href}\n`,
  );
  return { files, warnings };
}

/** Plain factual strings that should be present in a rendered site's visible copy. */
export function specFacts(spec: SiteSpec): string[] {
  return [
    ...new Set([
      spec.business.name,
      ...(spec.business.phone ? [spec.business.phone] : []),
      ...spec.business.hours.flatMap((hours) => [
        ...hours.days.map((day) => dayNames[day]),
        hours.opens,
        hours.closes,
      ]),
      ...spec.business.serviceArea,
    ]),
  ];
}

export type PlaceholderMatch = { file: string; placeholder: string };
export function findPlaceholders(
  files: ReadonlyMap<string, string>,
): PlaceholderMatch[] {
  const found: PlaceholderMatch[] = [];
  for (const [file, content] of files) {
    const matches =
      content.match(/lorem|ipsum|TODO|example\.com|\[your|xxx-xxxx/gi) ?? [];
    for (const placeholder of new Set(
      matches.map((match) => match.toLowerCase()),
    ))
      found.push({ file, placeholder });
  }
  return found;
}
