export const THEME_PRESETS = {
  evergreen: { bg: "#f5f8f5", surface: "#ffffff", text: "#172d24", muted: "#466154", primary: "#245c42", primaryText: "#ffffff", accent: "#d9b56d" },
  ocean: { bg: "#f2f7fb", surface: "#ffffff", text: "#182f45", muted: "#4a6075", primary: "#175781", primaryText: "#ffffff", accent: "#64b8c4" },
  terracotta: { bg: "#fcf6f0", surface: "#ffffff", text: "#39251d", muted: "#765546", primary: "#924529", primaryText: "#ffffff", accent: "#dfb385" },
  plum: { bg: "#faf5fb", surface: "#ffffff", text: "#352239", muted: "#705875", primary: "#6d397c", primaryText: "#ffffff", accent: "#d6acd9" },
  charcoal: { bg: "#f6f6f6", surface: "#ffffff", text: "#252525", muted: "#595959", primary: "#333333", primaryText: "#ffffff", accent: "#c2a15b" },
  midnight: { bg: "#101b2b", surface: "#1b2b40", text: "#f1f5fa", muted: "#b1c0d3", primary: "#9cc9ff", primaryText: "#10243e", accent: "#e3be76" },
  rose: { bg: "#fff5f6", surface: "#ffffff", text: "#42252b", muted: "#79545b", primary: "#913f55", primaryText: "#ffffff", accent: "#e8afbb" },
  sand: { bg: "#faf8ef", surface: "#ffffff", text: "#343321", muted: "#666343", primary: "#585c2b", primaryText: "#ffffff", accent: "#c8b874" },
} as const;

export const FONT_PAIRINGS = {
  modern: { heading: "Arial, Helvetica, sans-serif", body: "Arial, Helvetica, sans-serif" },
  editorial: { heading: "Georgia, 'Times New Roman', serif", body: "Arial, Helvetica, sans-serif" },
  classic: { heading: "Georgia, 'Times New Roman', serif", body: "Georgia, 'Times New Roman', serif" },
  humanist: { heading: "'Trebuchet MS', Arial, sans-serif", body: "Verdana, Geneva, sans-serif" },
  clean: { heading: "Verdana, Geneva, sans-serif", body: "Tahoma, Arial, sans-serif" },
} as const;

/** WCAG relative luminance for catalog colours (#rrggbb). */
export function contrastRatio(a: string, b: string): number {
  function luminance(hex: string) {
    if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error("Expected a six-digit hex colour");
    const channels = [1, 3, 5].map((offset) => {
      const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  }
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
