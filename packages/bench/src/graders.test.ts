import { describe, expect, test } from "bun:test";
import { renderSite, type SiteSpec } from "@homehost/sites";
import { gradeSite, visibleText } from "./graders";
import { example, task } from "./fixtures.test-helper";

const grades = (
  spec: unknown = example,
  files?: Map<string, string>,
  t = task,
) => Object.fromEntries(gradeSite(t, spec, files).map((g) => [g.id, g]));
describe("deterministic graders", () => {
  test("all checked-in example sites pass using their own brief facts", async () => {
    for (const name of ["plumber", "cafe", "hair-salon"]) {
      const spec = (await Bun.file(
        new URL(`../../sites/examples/${name}.json`, import.meta.url),
      ).json()) as SiteSpec;
      const t = {
        ...task,
        brief: {
          businessName: spec.business.name,
          niche: spec.business.niche,
          description: "Fixture description",
          phone: spec.business.phone,
          email: spec.business.email,
          serviceArea: spec.business.serviceArea,
          hours: spec.business.hours,
        },
        expect: {},
      };
      expect(gradeSite(t, spec).filter((g) => !g.pass)).toEqual([]);
    }
  });
  test("invalid schema fails rendering and downstream checks", () => {
    const result = grades({ version: 99 });
    expect(result.schemaValid.pass).toBe(false);
    expect(result.renders.pass).toBe(false);
    expect(result.factsPresent.pass).toBe(false);
  });
  test("facts match visible text, not metadata or attributes", () => {
    const files = renderSite(example, {
      baseUrl: "https://bench.invalid",
    }).files;
    files.set(
      "index.html",
      files
        .get("index.html")!
        .replace(
          "<main",
          '<script>Secret fact</script><img alt="Secret fact"><main',
        ),
    );
    expect(
      grades(example, files, {
        ...task,
        expect: { requiredFacts: ["Secret fact"] },
      }).factsPresent.pass,
    ).toBe(false);
    expect(
      visibleText(
        "<head><title>hidden</title></head><p>A &amp; B &#39; café</p><style>hide</style>",
      ),
    ).toBe("A & B ' café");
  });
  test("whitespace, entities and Canadian phone formats normalize", () => {
    const files = renderSite(example, {
      baseUrl: "https://bench.invalid",
    }).files;
    for (const [path, html] of files)
      files.set(path, html.replaceAll("+1 (250) 555-0147", "250.555.0147"));
    expect(grades(example, files).factsPresent.pass).toBe(true);
    expect(grades(example, files).briefFidelity.pass).toBe(true);
  });
  test("missing facts, placeholders and forbidden claims are independent failures", () => {
    const spec = structuredClone(example);
    spec.pages[0]!.sections.push({
      type: "about.text",
      heading: "TODO",
      text: "Award-winning",
    });
    const result = grades(spec, undefined, {
      ...task,
      expect: { requiredFacts: ["$149"], forbidden: ["award-winning"] },
    });
    expect(result.factsPresent.pass).toBe(false);
    expect(result.noPlaceholders.pass).toBe(false);
    expect(result.noForbidden.pass).toBe(false);
    expect(result.schemaValid.pass).toBe(true);
  });
  test("page bounds and HTML plus CSS byte limit are enforced", () => {
    const files = renderSite(example, {
      baseUrl: "https://bench.invalid",
    }).files;
    files.set("styles.css", "é".repeat(50_000));
    expect(grades(example, files).pageWeight.pass).toBe(false);
    expect(
      grades(example, undefined, { ...task, expect: { maxPages: 2 } }).pageCount
        .pass,
    ).toBe(false);
    expect(
      grades(example, undefined, { ...task, expect: { minPages: 4 } }).pageCount
        .pass,
    ).toBe(false);
  });
  test("business name must exactly match title and branded header", () => {
    const files = renderSite(example, {
      baseUrl: "https://bench.invalid",
    }).files;
    files.set(
      "index.html",
      files
        .get("index.html")!
        .replace("<title>Cedar Grove Plumbing</title>", "<title>Other</title>"),
    );
    expect(grades(example, files).briefFidelity.pass).toBe(false);
    const spec = structuredClone(example);
    spec.business.name = "Cedar grove plumbing";
    expect(grades(spec).briefFidelity.pass).toBe(false);
  });
  test("invented contacts in copy or spec fail, including the no-phone case", () => {
    const spec = structuredClone(example);
    spec.pages[0]!.sections.push({
      type: "about.text",
      heading: "Reach us",
      text: "Call 604-555-0100 or email fake@invented.test",
    });
    expect(grades(spec).briefFidelity.pass).toBe(false);
    expect(
      grades(example, undefined, {
        ...task,
        brief: { ...task.brief, phone: undefined },
      }).briefFidelity.pass,
    ).toBe(false);
    spec.business.email = "fake@invented.test";
    expect(grades(spec).briefFidelity.detail).toContain("Spec email");
  });
});
