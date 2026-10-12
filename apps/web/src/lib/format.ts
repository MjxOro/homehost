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

/** Build time for "Built in ...": "18 seconds", "1 min 42 sec", "14 min", "2 h 5 min". */
export function formatBuildTime(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  if (total < 600) {
    const seconds = total % 60;
    const minutes = `${Math.floor(total / 60)} min`;
    return seconds === 0 ? minutes : `${minutes} ${seconds} sec`;
  }
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  const hours = `${Math.floor(minutes / 60)} h`;
  return rest === 0 ? hours : `${hours} ${rest} min`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
