import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  DEFAULT_THEME,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  resolveThemeColor,
  subscribeSystemThemeColor,
  THEME_CHANGE_EVENT,
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
} from "./theme.ts";

interface RunInitScriptOptions {
  readonly systemPrefersLight?: boolean;
  readonly withThemeColorMeta?: boolean;
}

const runInitScript = (
  storage: () => string | null,
  options: RunInitScriptOptions = {},
): { readonly theme: string | undefined; readonly themeColor: string | null } => {
  const documentElement = { dataset: {} as Record<string, string> };
  let themeColor: string | null = options.withThemeColorMeta ? THEME_COLOR_DARK : null;
  const meta =
    options.withThemeColorMeta === true
      ? {
          setAttribute: (name: string, value: string) => {
            if (name === "content") themeColor = value;
          },
        }
      : null;

  const doc = {
    documentElement,
    ...(options.withThemeColorMeta
      ? {
          querySelector: (selector: string) =>
            selector === 'meta[name="theme-color"]' ? meta : null,
        }
      : {}),
  };

  const win = {
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: light)" && options.systemPrefersLight === true,
    }),
  };

  new Function("document", "localStorage", "window", THEME_INIT_SCRIPT)(
    doc,
    { getItem: storage },
    win,
  );
  return { theme: documentElement.dataset["theme"], themeColor };
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

  it("resolves theme-color between Dark (#0B0D12) and Light (#F4F6FA)", () => {
    expect(THEME_COLOR_DARK).toBe("#0B0D12");
    expect(THEME_COLOR_LIGHT).toBe("#F4F6FA");
    expect(resolveThemeColor("dark", false)).toBe("#0B0D12");
    expect(resolveThemeColor("dark", true)).toBe("#0B0D12");
    expect(resolveThemeColor("light", false)).toBe("#F4F6FA");
    expect(resolveThemeColor("light", true)).toBe("#F4F6FA");
    expect(resolveThemeColor("system", false)).toBe("#0B0D12");
    expect(resolveThemeColor("system", true)).toBe("#F4F6FA");
  });

  it("init script reads the stored preference with the shared key", () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(runInitScript(() => "light").theme).toBe("light");
    expect(runInitScript(() => "system").theme).toBe("system");
    expect(runInitScript(() => "dark").theme).toBe("dark");
  });

  it("init script synchronizes <meta name='theme-color'> on load", () => {
    expect(runInitScript(() => "light", { withThemeColorMeta: true }).themeColor).toBe("#F4F6FA");
    expect(runInitScript(() => "dark", { withThemeColorMeta: true }).themeColor).toBe("#0B0D12");
    expect(
      runInitScript(() => "system", { withThemeColorMeta: true, systemPrefersLight: true })
        .themeColor,
    ).toBe("#F4F6FA");
    expect(
      runInitScript(() => "system", { withThemeColorMeta: true, systemPrefersLight: false })
        .themeColor,
    ).toBe("#0B0D12");
  });

  it("init script falls back to dark when nothing/garbage is stored or storage throws", () => {
    expect(runInitScript(() => null, { withThemeColorMeta: true })).toEqual({
      theme: "dark",
      themeColor: "#0B0D12",
    });
    expect(runInitScript(() => "banana", { withThemeColorMeta: true })).toEqual({
      theme: "dark",
      themeColor: "#0B0D12",
    });
    expect(
      runInitScript(
        () => {
          throw new Error("SecurityError");
        },
        { withThemeColorMeta: true },
      ),
    ).toEqual({
      theme: "dark",
      themeColor: "#0B0D12",
    });
  });
});

describe("browser helpers (toggle + selector + theme-color)", () => {
  const stubBrowser = (
    storage: { setItem: (key: string, value: string) => void },
    options: { systemPrefersLight?: boolean } = {},
  ) => {
    const dataset: Record<string, string> = {};
    const events: string[] = [];
    let themeColor: string = THEME_COLOR_DARK;
    let prefersLight = options.systemPrefersLight === true;
    const mediaListeners: Array<() => void> = [];

    const meta = {
      setAttribute: (name: string, value: string) => {
        if (name === "content") themeColor = value;
      },
    };

    vi.stubGlobal("document", {
      documentElement: { dataset },
      querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
    });
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent: (event: Event) => events.push(event.type),
      matchMedia: (query: string) => ({
        get matches() {
          return query === "(prefers-color-scheme: light)" && prefersLight;
        },
        addEventListener: (_type: string, cb: () => void) => mediaListeners.push(cb),
        removeEventListener: (_type: string, cb: () => void) => {
          const idx = mediaListeners.indexOf(cb);
          if (idx >= 0) mediaListeners.splice(idx, 1);
        },
      }),
    });

    return {
      dataset,
      events,
      getThemeColor: () => themeColor,
      setSystemPrefersLight: (next: boolean) => {
        prefersLight = next;
        for (const cb of [...mediaListeners]) cb();
      },
    };
  };

  afterEach(() => vi.unstubAllGlobals());

  it("applies the preference to data-theme, updates theme-color, persists it and notifies", () => {
    const setItem = vi.fn();
    const { dataset, events, getThemeColor } = stubBrowser(
      { setItem },
      { systemPrefersLight: true },
    );

    applyThemePreference("system");
    expect(dataset["theme"]).toBe("system");
    expect(readThemePreference()).toBe("system");
    expect(getThemeColor()).toBe("#F4F6FA");

    applyThemePreference("dark");
    expect(dataset["theme"]).toBe("dark");
    expect(getThemeColor()).toBe("#0B0D12");

    applyThemePreference("light");
    expect(dataset["theme"]).toBe("light");
    expect(getThemeColor()).toBe("#F4F6FA");

    expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "light");
    expect(events).toEqual([THEME_CHANGE_EVENT, THEME_CHANGE_EVENT, THEME_CHANGE_EVENT]);
  });

  it("keeps theme-color synced when OS prefers-color-scheme changes in system mode", () => {
    const { dataset, getThemeColor, setSystemPrefersLight } = stubBrowser(
      { setItem: () => undefined },
      { systemPrefersLight: false },
    );
    dataset["theme"] = "system";
    const unsubscribe = subscribeSystemThemeColor();
    expect(getThemeColor()).toBe("#0B0D12");

    setSystemPrefersLight(true);
    expect(getThemeColor()).toBe("#F4F6FA");

    setSystemPrefersLight(false);
    expect(getThemeColor()).toBe("#0B0D12");

    unsubscribe();
    setSystemPrefersLight(true);
    expect(getThemeColor()).toBe("#0B0D12");
  });

  it("still applies the theme when localStorage throws", () => {
    const { dataset, events, getThemeColor } = stubBrowser({
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => applyThemePreference("light")).not.toThrow();
    expect(dataset["theme"]).toBe("light");
    expect(getThemeColor()).toBe("#F4F6FA");
    expect(events).toEqual([THEME_CHANGE_EVENT]);
  });

  it("reads dark when data-theme is missing or invalid", () => {
    const { dataset } = stubBrowser({ setItem: () => undefined });
    expect(readThemePreference()).toBe("dark");
    dataset["theme"] = "neon";
    expect(readThemePreference()).toBe("dark");
  });
});
