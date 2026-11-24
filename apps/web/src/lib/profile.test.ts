import { describe, expect, it } from "vitest";
import { avatarInitials } from "./profile.ts";

describe("avatarInitials", () => {
  it.each([
    ["Ada Lovelace", "AL"],
    ["ada", "AD"],
    ["x", "X"],
    ["jean-michel dupont", "JM"],
    ["émilie  ôtomne", "ÉÔ"],
    ["  Ash   Ketchum  Jr ", "AK"],
    ["", "CO"],
    ["***", "CO"],
    [null, "CO"],
    [undefined, "CO"],
  ])("%j -> %s", (name, expected) => {
    expect(avatarInitials(name)).toBe(expected);
  });
});
