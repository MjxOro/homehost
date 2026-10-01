// Deterministic guard, not a vault or proof that arbitrary text contains no secret.
// Keep this pure so the API and browser use exactly the same detection rules.
const TOKEN_PATTERNS = [
  /\b[A-Za-z0-9_-]{17,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,110}\b/,
  /\b\d{5,20}:[A-Za-z0-9_-]{30,}\b/,
  /\bsk-(?:or-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function containsSecret(text: string): boolean {
  if (TOKEN_PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const match of text.matchAll(/[A-Za-z0-9_+/=-]{32,}/g)) {
    const value = match[0];
    // Request/conversation ids are safe to discuss.
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) continue;
    if (/^[0-9a-f]{40,}$/i.test(value) && entropy(value) >= 3.5) return true;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[_+/=-]/].filter((p) =>
      p.test(value),
    ).length;
    if (classes >= 2 && entropy(value) >= 4.3) return true;
  }
  return false;
}
