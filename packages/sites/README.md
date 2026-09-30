# @homehost/sites

A bounded JSON site spec and a pure, deterministic static renderer for small business websites. **AI fills the spec; code renders the website.** There are no AI calls or user-supplied HTML, CSS, scripts, fonts or map URLs.

The version-1 spec has `business` (name, niche, optional contact details, service areas, weekly hours and HTTPS socials), `theme` (palette and system-font pairing IDs), and `pages` (unique slug, title, description and catalog sections). Exactly one page has the home slug `""`; there are at most 8 pages and 12 sections per page. Every free-text field and array is bounded. See [examples](./examples) for complete plumber, hair salon and café specs with invented Canadian business details.

The 13 section IDs are `hero.split-image`, `hero.centered`, `services.grid`, `about.text`, `testimonials.cards`, `gallery.grid`, `hours.table`, `contact.details`, `cta.banner`, `faq.list`, `pricing.table`, `team.cards` and `map.embed`. Images use HTTPS URLs or site-relative paths. Actions use HTTPS URLs, site-relative paths or fragment links. Section anchors follow the prefix (`#contact`, `#hours`, etc.), with numeric suffixes for repeats. Telephone/email links and Google Maps embeds come from business fields. Deploy referenced local image assets separately; rendering only emits text files.

```sh
bun packages/sites/src/cli.ts render packages/sites/examples/plumber.json /tmp/sites-out/plumber --base-url https://cedargroveplumbing.ca
bun test packages/sites
bun run --filter '@homehost/sites' typecheck
```

The CLI prints validation issues and exits 1 on errors; it prints warnings for derived image alt text or a map without an address. The default base URL is `https://localhost`; set the deployment URL for production SEO. It writes each page, shared `styles.css`, `sitemap.xml` and `robots.txt` and replaces files with the same names in the output directory. Base URLs may include a deployment path; site-relative actions and images refer to the host root.

The package exports `SiteSpec`, `Section`, `validateSpec`, `siteSpecJsonSchema`, `THEME_PRESETS`, `FONT_PAIRINGS`, `contrastRatio`, `renderSite`, `applySpecPatch`, `SpecPatchError`, `specFacts` and `findPlaceholders`. JSON Schema includes catalog variants and size limits; cross-page home/uniqueness checks also run through `validateSpec`. Patches support RFC 6902 add/remove/replace/move/copy/test, clone inputs, and validate the final spec. Invalid results throw `SpecPatchError` with `issues`. `specFacts` returns visible name, phone, hours and service-area strings; `findPlaceholders` returns `{ file, placeholder }` matches.
