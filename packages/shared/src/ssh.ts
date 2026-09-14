/** Longest accepted single-line public key, comment included. */
export const SSH_KEY_MAX = 2048;

/** SSH public-key validation for the request form and the API gate. */

const KEY_TYPES: Record<string, true> = {
  "ssh-rsa": true,
  "ssh-dss": true,
  "ssh-ed25519": true,
  "ecdsa-sha2-nistp256": true,
  "ecdsa-sha2-nistp384": true,
  "ecdsa-sha2-nistp521": true,
  "sk-ssh-ed25519@openssh.com": true,
  "sk-ecdsa-sha2-nistp256@openssh.com": true,
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** True for a single-line `<type> <base64> [comment]` key whose blob embeds its type. */
export function isValidSshPublicKey(raw: string): boolean {
  const key = raw.trim();
  if (key.length === 0 || key.length > SSH_KEY_MAX || key.includes("\n")) {
    return false;
  }
  const parts = key.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  const [type, blob] = parts;
  if (type === undefined || blob === undefined) return false;
  if (KEY_TYPES[type] !== true || !BASE64.test(blob) || blob.length % 4 !== 0) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    const bin = atob(blob);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  if (bytes.length < 4) return false;
  const len = new DataView(bytes.buffer).getUint32(0);
  if (len !== type.length || bytes.length < 4 + len) return false;
  const embedded = String.fromCharCode(...bytes.slice(4, 4 + len));
  return embedded === type;
}
