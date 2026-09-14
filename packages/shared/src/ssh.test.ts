import { describe, expect, test } from "bun:test";
import { SSH_KEY_MAX, isValidSshPublicKey } from "./ssh.js";

const ED =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcfXKn/5G39jJ5beNyDe3WnorXY9oa5Cu2Cif8x5gWI alice@kitchen";
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC22pXohYuwRBCohN7KaqlRpTXAUVMSrU+YAqA/KN+yE+FFCM38ui+4v9+//iqaZ87SIBSojJ410lyR5C/MTuLnlKYkk94J9XrvZhDj1pKUx5HObR+NdILHqtP4KRZwW9Nd5aFT3D2L0AQ75p1z0Ok9rQek/pCBTznxFvjjRfjOjCkEXIsaWeKoKn0+Il5Vy7s47GQ3U2i4uGWnM8uHIZjJrsCP3Xqwph2aqvTOUcc72R/HtAMxs4wo4XwatKfagi7BZjXa9img5lBCGS8ZWVXux38lOqHLTVRSOTxAVAZPUrVlWpuL0f+nIqpBgGYnTMk7w/RHMrWnUBlxtIIASstv pairing-note";

describe("ssh public-key gate", () => {
  test("accepts well-formed keys with or without comment", () => {
    expect(isValidSshPublicKey(ED)).toBe(true);
    expect(isValidSshPublicKey(ED.split(" ").slice(0, 2).join(" "))).toBe(true);
    expect(isValidSshPublicKey(RSA)).toBe(true);
  });

  test("rejects wrong type, bad blob, and type/blob mismatch", () => {
    expect(
      isValidSshPublicKey("ssh-fish AAAAC3NzaC1lZDI1NTE5AAAAIOMq alice"),
    ).toBe(false);
    // ed25519 blob labelled as rsa: embedded type disagrees.
    const edBlob = ED.split(" ")[1];
    expect(isValidSshPublicKey(`ssh-rsa ${edBlob} alice`)).toBe(false);
  });

  test("rejects multiline, empty, and oversized input", () => {
    expect(isValidSshPublicKey("")).toBe(false);
    expect(isValidSshPublicKey(`${ED}\n${ED}`)).toBe(false);
    expect(isValidSshPublicKey(`ssh-ed25519 ${"A".repeat(SSH_KEY_MAX)}`)).toBe(
      false,
    );
  });
});
