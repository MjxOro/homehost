import {
  findPlaceholders,
  renderSite,
  validateSpec,
  type SiteSpec,
} from "@homehost/sites";
import type { Task } from "./tasks";

export type Grade = { id: string; pass: boolean; detail: string };
const grade = (id: string, issues: string[]): Grade => ({
  id,
  pass: !issues.length,
  detail: issues.join("; ") || "OK",
});

export function decodeHtml(text: string): string {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const code =
          entity[1]?.toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return (
        (
          {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
            nbsp: " ",
          } as Record<string, string>
        )[entity.toLowerCase()] ?? match
      );
    },
  );
}

export function visibleText(html: string): string {
  return decodeHtml(
    html
      .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
const normalize = (value: string) =>
  value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const phoneKey = (value: string) =>
  value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const phones = (value: string) =>
  value.match(
    /(?<![\w:])(?:\+?1[ .()-]*)?\(?\d{3}\)?[ .-]*\d{3}[ .-]*\d{4}(?!\d)/g,
  ) ?? [];
const emails = (value: string) =>
  value.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];

function contactText(value: string): string {
  const decoded = decodeHtml(value);
  try {
    return decodeURIComponent(decoded).replace(/^(tel:|mailto:)/i, " ");
  } catch {
    return decoded.replace(/^(tel:|mailto:)/i, " ");
  }
}

function requiredFacts(task: Task): string[] {
  const b = task.brief;
  const days = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday",
  };
  return [
    ...new Set(
      [
        b.businessName,
        b.city,
        b.phone,
        b.email,
        ...Object.values(b.address ?? {}),
        ...(b.serviceArea ?? []),
        ...(b.hours ?? []).flatMap((h) => [
          ...h.days.map((d) => days[d]),
          h.opens,
          h.closes,
        ]),
        ...(task.expect.requiredFacts ?? []),
      ].filter((value): value is string => !!value),
    ),
  ];
}

/** Pure deterministic checks; callers may supply rendered files for testing. */
export function gradeSite(
  task: Task,
  input: unknown,
  supplied?: ReadonlyMap<string, string>,
): Grade[] {
  const validation = validateSpec(input);
  let files = supplied;
  let renderError: string | undefined;
  if (!files && validation.ok) {
    try {
      files = renderSite(validation.spec, {
        baseUrl: "https://bench.invalid",
      }).files;
    } catch (error) {
      renderError = String(error);
    }
  }
  const schema = grade(
    "schemaValid",
    validation.ok
      ? []
      : validation.issues.map((i) => `${i.path}: ${i.message}`),
  );
  const rendered = grade(
    "renders",
    files?.has("index.html") && files.has("styles.css")
      ? []
      : [renderError ?? "Missing home HTML/CSS or invalid spec"],
  );
  if (!files)
    return [
      schema,
      rendered,
      ...[
        "factsPresent",
        "noPlaceholders",
        "noForbidden",
        "pageCount",
        "pageWeight",
        "briefFidelity",
      ].map((id) => grade(id, ["No rendered site to grade"])),
    ];
  const html = [...files].filter(([path]) => path.endsWith(".html"));
  const text = html.map(([, content]) => visibleText(content)).join(" ");
  const normal = normalize(text);
  const missing = requiredFacts(task).filter((fact) => {
    if (task.brief.phone && phoneKey(fact) === phoneKey(task.brief.phone))
      return !phones(text).some((p) => phoneKey(p) === phoneKey(fact));
    return !normal.includes(normalize(fact));
  });
  const forbidden = (task.expect.forbidden ?? []).filter((f) =>
    normal.includes(normalize(f)),
  );
  const count = validation.ok ? validation.spec.pages.length : html.length;
  const bytes =
    Buffer.byteLength(files.get("index.html") ?? "") +
    Buffer.byteLength(files.get("styles.css") ?? "");
  const fidelity: string[] = [];
  for (const [path, content] of html) {
    const title = decodeHtml(
      content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
    ).trim();
    const header =
      content.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i)?.[1] ?? "";
    // Exact casing/name, allowing the renderer's "page | business" title.
    if (
      title !== task.brief.businessName &&
      !title.endsWith(` | ${task.brief.businessName}`)
    )
      fidelity.push(`${path}: business name missing from title`);
    const brand = header.match(
      /<a\b[^>]*class="brand"[^>]*>([\s\S]*?)<\/a>/i,
    )?.[1];
    if (visibleText(brand ?? "") !== task.brief.businessName)
      fidelity.push(`${path}: business name differs in header`);
  }
  // Inspect visible copy and contact links; ignore CSS, image URLs and JSON-LD.
  const contacts =
    text +
    " " +
    html
      .flatMap(([, h]) =>
        [...h.matchAll(/href="((?:tel:|mailto:)[^"]+)"/gi)].map((m) =>
          contactText(m[1]!),
        ),
      )
      .join(" ");
  for (const p of new Set(phones(contacts)))
    if (!task.brief.phone || phoneKey(p) !== phoneKey(task.brief.phone))
      fidelity.push(`Invented phone: ${p}`);
  for (const e of new Set(emails(contacts)))
    if (normalize(e) !== normalize(task.brief.email ?? ""))
      fidelity.push(`Invented email: ${e}`);
  if (validation.ok) {
    const b: SiteSpec["business"] = validation.spec.business;
    if (
      b.phone &&
      (!task.brief.phone || phoneKey(b.phone) !== phoneKey(task.brief.phone))
    )
      fidelity.push("Spec phone differs from brief");
    if (b.email && normalize(b.email) !== normalize(task.brief.email ?? ""))
      fidelity.push("Spec email differs from brief");
  }
  return [
    schema,
    rendered,
    grade(
      "factsPresent",
      missing.map((f) => `Missing: ${f}`),
    ),
    grade(
      "noPlaceholders",
      findPlaceholders(files).map((m) => `${m.file}: ${m.placeholder}`),
    ),
    grade(
      "noForbidden",
      forbidden.map((f) => `Forbidden: ${f}`),
    ),
    grade(
      "pageCount",
      count < (task.expect.minPages ?? 1) || count > (task.expect.maxPages ?? 8)
        ? [`${count} pages outside expected range`]
        : [],
    ),
    grade(
      "pageWeight",
      bytes < 100_000
        ? []
        : [`Home HTML + CSS: ${bytes} bytes (limit <100000)`],
    ),
    grade("briefFidelity", fidelity),
  ];
}
