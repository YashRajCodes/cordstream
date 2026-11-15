import { describe, expect, test } from "bun:test";
import { hasAdministratorPermission } from "./permissions";

describe("hasAdministratorPermission", () => {
  test("allows server owners", () => {
    expect(hasAdministratorPermission({ owner: true })).toBe(true);
  });

  test("allows the Administrator permission", () => {
    expect(hasAdministratorPermission({ permissions: "8" })).toBe(true);
    expect(hasAdministratorPermission({ permissions: "1032" })).toBe(true);
  });

  test("does not treat other server permissions as Administrator", () => {
    expect(hasAdministratorPermission({ permissions: "32" })).toBe(false);
    expect(hasAdministratorPermission({ permissions: "0" })).toBe(false);
  });

  test("fails closed for malformed permissions", () => {
    expect(hasAdministratorPermission({ permissions: "invalid" })).toBe(false);
  });
});
