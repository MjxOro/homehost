import { expect, test } from "bun:test";
import { validateSpec, renderSite, findPlaceholders, specFacts } from "./index";

test.each(["plumber", "hair-salon", "cafe"])(
  "%s example validates, renders and contains all required facts with no placeholders",
  async (name) => {
    const input: unknown = await Bun.file(
      new URL(`../examples/${name}.json`, import.meta.url),
    ).json();
    const validation = validateSpec(input);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
    const result = renderSite(validation.spec, {
      baseUrl: `https://${name}.homehost.ca`,
    });
    expect(result.warnings).toHaveLength(0);
    expect(findPlaceholders(result.files)).toEqual([]);
    const visible = [...result.files]
      .filter(([path]) => path.endsWith(".html"))
      .map(([, html]) =>
        html.replace(/<head>.*?<\/head>/s, "").replaceAll("&amp;", "&"),
      )
      .join("\n");
    for (const fact of specFacts(validation.spec))
      expect(visible).toContain(fact);
    expect(
      [...result.files].filter(([path]) => path.endsWith(".html")),
    ).toHaveLength(validation.spec.pages.length);
  },
);
