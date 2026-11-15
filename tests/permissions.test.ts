import { describe, expect, test } from "bun:test";
import { hasAdministratorPermission, hasApplicationAccess } from "../src/permissions";

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

describe("hasApplicationAccess", () => {
  const application = {
    id: "application",
    owner: { id: "owner" },
    team: {
      owner_user_id: "team-owner",
      members: [
        { user: { id: "developer" }, membership_state: 2 },
        { user: { id: "invited" }, membership_state: 1 },
      ],
    },
  };

  test("allows the application owner and accepted team members", () => {
    expect(hasApplicationAccess(application, "owner", "application")).toBe(true);
    expect(hasApplicationAccess(application, "team-owner", "application")).toBe(true);
    expect(hasApplicationAccess(application, "developer", "application")).toBe(true);
  });

  test("rejects users outside the application team", () => {
    expect(hasApplicationAccess(application, "someone-else", "application")).toBe(false);
    expect(hasApplicationAccess(application, "invited", "application")).toBe(false);
    expect(hasApplicationAccess(application, "owner", "another-application")).toBe(false);
  });
});
