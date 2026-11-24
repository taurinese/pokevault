import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  DEFAULT_THEME,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_CHANGE_EVENT,
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

describe("browser helpers (toggle + selector)", () => {
  const stubBrowser = (storage: { setItem: (key: string, value: string) => void }) => {
    const dataset: Record<string, string> = {};
    const events: string[] = [];
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: (event: Event) => events.push(event.type),
    });
    return { dataset, events };
  };

  afterEach(() => vi.unstubAllGlobals());

  it("applies the preference to data-theme, persists it and notifies", () => {
    const setItem = vi.fn();
    const { dataset, events } = stubBrowser({ setItem });
    for (const preference of ["system", "dark", "light"] as const) {
      applyThemePreference(preference);
      expect(dataset["theme"]).toBe(preference);
      expect(readThemePreference()).toBe(preference);
      expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, preference);
    }
    expect(events).toEqual([THEME_CHANGE_EVENT, THEME_CHANGE_EVENT, THEME_CHANGE_EVENT]);
  });

  it("still applies the theme when localStorage throws", () => {
    const { dataset, events } = stubBrowser({
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => applyThemePreference("light")).not.toThrow();
    expect(dataset["theme"]).toBe("light");
    expect(events).toEqual([THEME_CHANGE_EVENT]);
  });

  it("reads dark when data-theme is missing or invalid", () => {
    const { dataset } = stubBrowser({ setItem: () => undefined });
    expect(readThemePreference()).toBe("dark");
    dataset["theme"] = "neon";
    expect(readThemePreference()).toBe("dark");
  });
});
