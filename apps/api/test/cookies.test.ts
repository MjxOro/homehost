import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCookiePolicy } from "../src/auth/cookies.js";

for (const origin of [
  "http://127.0.0.1:5174",
  "http://192.168.1.16:5174",
  "https://panel.example.test",
]) {
  test(`cookie policy derives names and attributes from ${origin}`, () => {
    const policy = createCookiePolicy(origin);
    const secure = origin.startsWith("https:");
    const prefix = secure ? "__Host-" : "";
    const token = randomUUID();
    for (const [header, name] of [
      [policy.session(token), "hh_session"],
      [policy.state(token), "hh_oauth_state"],
      [policy.clearSession(), "hh_session"],
      [policy.clearState(), "hh_oauth_state"],
    ]) {
      expect(header).toStartWith(`${prefix}${name}=`);
      expect(header).toContain("Path=/; HttpOnly; SameSite=Lax");
      expect(header!.includes("; Secure")).toBe(secure);
      expect(header).not.toContain("Domain=");
    }
    expect(policy.getSession(`${prefix}hh_session=${token}`)).toBe(token);
    expect(policy.getState(`${prefix}hh_oauth_state=${token}`)).toBe(token);
    expect(
      policy.getSession(`${secure ? "" : "__Host-"}hh_session=${token}`),
    ).toBeNull();
    expect(
      policy.getState(`${secure ? "" : "__Host-"}hh_oauth_state=${token}`),
    ).toBeNull();
    expect(policy.getState(`${prefix}hh_oauth_state=%ZZ`)).toBeNull();
    expect(policy.clearSession()).toContain("Max-Age=0");
    expect(policy.clearState()).toContain("Max-Age=0");
  });
}
