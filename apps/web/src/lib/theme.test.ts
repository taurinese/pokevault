import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  parseThemePreference,
  resolveTheme,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
} from "./theme.ts";

const runInitScript = (storage: () => string | null): string | undefined => {
  const documentElement = { dataset: {} as Record<string, string> };
  new Function("document", "localStorage", THEME_INIT_SCRIPT)(
    { documentElement },
    { getItem: storage },
  );
  return documentElement.dataset["theme"];
};

describe("theme", () => {
  it("defaults to dark", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(parseThemePreference(null)).toBe("dark");
    expect(parseThemePreference("nope")).toBe("dark");
  });

  it("parses the three explicit preferences", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("resolves system against prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("init script reads the stored preference with the shared key", () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(runInitScript(() => "light")).toBe("light");
    expect(runInitScript(() => "system")).toBe("system");
    expect(runInitScript(() => "dark")).toBe("dark");
  });

  it("init script falls back to dark when nothing/garbage is stored or storage throws", () => {
    expect(runInitScript(() => null)).toBe("dark");
    expect(runInitScript(() => "banana")).toBe("dark");
    expect(
      runInitScript(() => {
        throw new Error("SecurityError");
      }),
    ).toBe("dark");
  });
});
