import { FONT_PAIRINGS, THEME_PRESETS } from "./themes";
import type { SiteSpec } from "./schema";

export function styles(theme: SiteSpec["theme"]): string {
  const palette = THEME_PRESETS[theme.preset], fonts = FONT_PAIRINGS[theme.fonts];
  return `:root {
  --bg: ${palette.bg}; --surface: ${palette.surface}; --text: ${palette.text};
  --muted: ${palette.muted}; --primary: ${palette.primary}; --primary-text: ${palette.primaryText}; --accent: ${palette.accent};
  --heading-font: ${fonts.heading}; --body-font: ${fonts.body};
}
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: ${theme.preset === "midnight" ? "dark" : "light"}; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--body-font); line-height: 1.65; overflow-wrap: anywhere; }
h1, h2, h3 { font-family: var(--heading-font); line-height: 1.2; margin: 0 0 1rem; }
h1 { font-size: clamp(2rem, 6vw, 3.75rem); }
h2 { font-size: clamp(1.5rem, 4vw, 2.25rem); }
h3 { font-size: 1.2rem; }
p { margin: 0 0 1rem; }
a { color: var(--primary); text-underline-offset: .2em; }
a:hover { text-decoration-thickness: .15em; }
:focus-visible { outline: 3px solid var(--primary); outline-offset: 4px; }
img { display: block; width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; border-radius: .75rem; }
iframe { display: block; width: 100%; max-width: 100%; border: 0; border-radius: .75rem; }
.wrap { width: min(100% - 2rem, 72rem); margin-inline: auto; }
.skip-link { position: absolute; top: .5rem; left: .5rem; padding: .75rem; background: var(--surface); z-index: 10; translate: 0 -200%; }
.skip-link:focus { translate: 0 0; }
.site-header { border-bottom: 1px solid var(--muted); padding-block: 1rem; }
.header-inner, .site-nav, .socials { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; align-items: center; }
.header-inner { justify-content: space-between; }
.brand { font-family: var(--heading-font); font-weight: 700; font-size: 1.25rem; text-decoration: none; }
.brand, .site-nav a, .socials a, .contact-link { display: inline-flex; align-items: center; min-height: 44px; }
.site-nav a { padding: .4rem .25rem; }
.site-nav a[aria-current="page"] { font-weight: 700; text-decoration-thickness: .15em; }
section { padding-block: clamp(2.5rem, 6vw, 5rem); }
.hero, .banner { border-bottom: .25rem solid var(--accent); }
.hero-centered, .banner { text-align: center; }
.hero-centered .copy, .banner .copy { margin-inline: auto; }
.copy { max-width: 65ch; white-space: pre-line; }
.split, .grid { display: grid; gap: 1.5rem; }
.split > *, .grid > * { min-width: 0; }
.grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
.card { background: var(--surface); padding: 1.5rem; border-radius: .75rem; }
.card img { margin-bottom: 1.25rem; }
.button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: .75rem 1.5rem; border-radius: .5rem; background: var(--primary); color: var(--primary-text); font-weight: 700; text-decoration: none; }
blockquote { margin: 0; }
blockquote footer { color: var(--muted); margin-top: 1rem; }
figure { margin: 0; }
.muted { color: var(--muted); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: .75rem .5rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--muted); }
caption { text-align: left; font-weight: 700; padding-bottom: .75rem; }
address { font-style: normal; white-space: pre-line; }
details { border-bottom: 1px solid var(--muted); padding-block: .5rem; }
summary { cursor: pointer; min-height: 44px; padding-block: .5rem; font-weight: 700; }
details .copy { margin-top: .75rem; }
.site-footer { border-top: 1px solid var(--muted); padding-block: 2.5rem; }
.site-footer .grid { gap: 2rem; }
.footer-name { margin-top: 2rem; }
@media (min-width: 48rem) { .split { grid-template-columns: 1fr 1fr; align-items: center; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
}
