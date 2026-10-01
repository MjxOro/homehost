const relativeFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});
const absoluteFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : absoluteFormatter.format(date);
}

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const divisions: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: "second" },
    { amount: 60, unit: "minute" },
    { amount: 24, unit: "hour" },
    { amount: 7, unit: "day" },
    { amount: 4.34524, unit: "week" },
    { amount: 12, unit: "month" },
    { amount: Number.POSITIVE_INFINITY, unit: "year" },
  ];
  let duration = seconds;
  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      return relativeFormatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return relativeFormatter.format(Math.round(duration), "year");
}

export function formatMemory(mb: number): string {
  return `${(mb / 1024).toLocaleString("en", { maximumFractionDigits: 1 })} GB`;
}

/** One-line plan size, e.g. "2 CPU · 2 GB RAM · 20 GB disk". */
export function formatPlanSpecs(plan: {
  cpu: number;
  memoryMb: number;
  diskGb: number;
}): string {
  return `${plan.cpu} CPU · ${formatMemory(plan.memoryMb)} RAM · ${plan.diskGb} GB disk`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
