import { describe, expect, it, vi } from "vitest";
import {
  type DeviceOrientationEventConstructorLike,
  type DeviceOrientationReading,
  GYRO_DEADZONE_DEG,
  GYRO_GAIN,
  type GyroDocumentLike,
  type GyroWindowLike,
  isDeviceOrientationSupported,
  normalizeScreenOrientationAngle,
  orientationToTilt,
  readScreenOrientationAngle,
  requestGyroPermission,
  requiresGyroPermission,
  subscribeDeviceOrientation,
} from "./card-3d-gyro.ts";
import { MAX_TILT_DEG, type TiltTarget, ZERO_TILT } from "./card-3d-physics.ts";

// ---------------------------------------------------------------------------
// Harnais simulés (window / document sans DOM global)
// ---------------------------------------------------------------------------

interface FakeGyroWindow extends GyroWindowLike {
  readonly orientationListeners: Set<(event: DeviceOrientationReading) => void>;
  emitOrientation: (reading: DeviceOrientationReading) => void;
  setScreenAngle: (angle: number) => void;
}

const createFakeWindow = (
  options: {
    readonly supported?: boolean;
    readonly requestPermission?: (() => Promise<string>) | undefined;
    readonly angle?: number;
    readonly reducedMotion?: boolean;
  } = {},
): FakeGyroWindow => {
  const orientationListeners = new Set<(event: DeviceOrientationReading) => void>();
  let screenAngle = options.angle ?? 0;

  const ctor: DeviceOrientationEventConstructorLike | undefined =
    options.supported === false
      ? undefined
      : options.requestPermission !== undefined
        ? { requestPermission: options.requestPermission }
        : {};

  return {
    orientationListeners,
    DeviceOrientationEvent: ctor,
    screen: {
      orientation: {
        get angle() {
          return screenAngle;
        },
      },
    },
    matchMedia: () => ({ matches: options.reducedMotion ?? false }),
    addEventListener: (_type, listener) => {
      orientationListeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      orientationListeners.delete(listener);
    },
    emitOrientation: (reading) => {
      for (const listener of [...orientationListeners]) {
        listener(reading);
      }
    },
    setScreenAngle: (nextAngle) => {
      screenAngle = nextAngle;
    },
  };
};

interface FakeGyroDocument extends GyroDocumentLike {
  readonly visibilityListeners: Set<() => void>;
  setHidden: (hidden: boolean) => void;
}

const createFakeDocument = (initialHidden = false): FakeGyroDocument => {
  const visibilityListeners = new Set<() => void>();
  let hidden = initialHidden;
  return {
    visibilityListeners,
    get hidden() {
      return hidden;
    },
    addEventListener: (_type, listener) => {
      visibilityListeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      visibilityListeners.delete(listener);
    },
    setHidden: (nextHidden) => {
      hidden = nextHidden;
      for (const listener of [...visibilityListeners]) {
        listener();
      }
    },
  };
};

// ---------------------------------------------------------------------------
// 1. Conversion pure orientation → TiltTarget
// ---------------------------------------------------------------------------

describe("orientationToTilt", () => {
  it("ignore les lectures nulles ou non finies", () => {
    expect(orientationToTilt({ beta: null, gamma: 10 }, { beta: 45, gamma: 0 })).toBeNull();
    expect(orientationToTilt({ beta: 45, gamma: null }, { beta: 45, gamma: 0 })).toBeNull();
    expect(orientationToTilt({ beta: Number.NaN, gamma: 0 }, { beta: 45, gamma: 0 })).toBeNull();
    expect(
      orientationToTilt({ beta: 45, gamma: Number.POSITIVE_INFINITY }, { beta: 45, gamma: 0 }),
    ).toBeNull();
  });

  it("retourne (0, 0) lorsque la posture est égale à la baseline (ex. téléphone tenu à 45°) ou sans baseline", () => {
    expect(orientationToTilt({ beta: 45, gamma: 3 }, null)).toEqual(ZERO_TILT);
    expect(orientationToTilt({ beta: 45, gamma: 3 }, { beta: 45, gamma: 3 }, 0)).toEqual(ZERO_TILT);
  });

  it("filtre le micro-jitter dans la deadzone puis applique une rampe continue avec gain", () => {
    const baseline = { beta: 45, gamma: 0 };

    // Dans la deadzone → 0° strict
    expect(
      orientationToTilt({ beta: 45 + GYRO_DEADZONE_DEG, gamma: -GYRO_DEADZONE_DEG }, baseline, 0),
    ).toEqual(ZERO_TILT);

    // Au-delà de la deadzone : rampe continue `(delta - deadzone) * gain`
    const tilted = orientationToTilt({ beta: 45 - 11.5, gamma: 11.5 }, baseline, 0);
    expect(tilted).not.toBeNull();
    const expected = (11.5 - GYRO_DEADZONE_DEG) * GYRO_GAIN;
    expect(tilted?.rx).toBeCloseTo(expected, 5);
    expect(tilted?.ry).toBeCloseTo(expected, 5);
  });

  it("borne strictement les angles de sortie sur [-22°, +22°]", () => {
    const baseline = { beta: 45, gamma: 0 };
    const extremePos = orientationToTilt({ beta: -30, gamma: 80 }, baseline, 0);
    expect(extremePos).toEqual({ rx: MAX_TILT_DEG, ry: MAX_TILT_DEG });

    const extremeNeg = orientationToTilt({ beta: 120, gamma: -80 }, baseline, 0);
    expect(extremeNeg).toEqual({ rx: -MAX_TILT_DEG, ry: -MAX_TILT_DEG });
  });

  it("adapte les axes à toutes les rotations d'écran (0°, 90°, -90°/270°, 180°)", () => {
    const baseline = { beta: 45, gamma: 0 };
    const reading = { beta: 45 + 10, gamma: 20 }; // deltaBeta = +10, deltaGamma = +20
    const expectedSmall = (10 - GYRO_DEADZONE_DEG) * GYRO_GAIN;
    const expectedLarge = (20 - GYRO_DEADZONE_DEG) * GYRO_GAIN;

    // 0° (portrait normal) : rx = -deltaBeta, ry = +deltaGamma
    const r0 = orientationToTilt(reading, baseline, 0);
    expect(r0?.rx).toBeCloseTo(-expectedSmall, 5);
    expect(r0?.ry).toBeCloseTo(expectedLarge, 5);

    // 90° (paysage gauche) : rx = +deltaGamma, ry = +deltaBeta
    const r90 = orientationToTilt(reading, baseline, 90);
    expect(r90?.rx).toBeCloseTo(expectedLarge, 5);
    expect(r90?.ry).toBeCloseTo(expectedSmall, 5);

    // 180° (portrait inversé) : rx = +deltaBeta, ry = -deltaGamma
    const r180 = orientationToTilt(reading, baseline, 180);
    expect(r180?.rx).toBeCloseTo(expectedSmall, 5);
    expect(r180?.ry).toBeCloseTo(-expectedLarge, 5);

    // -90° et 270° (paysage droit) : identiques, rx = -deltaGamma, ry = -deltaBeta
    const rNeg90 = orientationToTilt(reading, baseline, -90);
    const r270 = orientationToTilt(reading, baseline, 270);
    expect(rNeg90).toEqual(r270);
    expect(r270?.rx).toBeCloseTo(-expectedLarge, 5);
    expect(r270?.ry).toBeCloseTo(-expectedSmall, 5);
  });

  it("gère le passage à ±180° sans saut angulaire sur beta", () => {
    const result = orientationToTilt({ beta: -175, gamma: 0 }, { beta: 175, gamma: 0 }, 0);
    // +10° de deltaBeta → rx = -(10 - deadzone) * gain
    expect(result?.rx).toBeCloseTo(-(10 - GYRO_DEADZONE_DEG) * GYRO_GAIN, 5);
    expect(result?.ry).toBe(0);
  });
});

describe("normalizeScreenOrientationAngle & readScreenOrientationAngle", () => {
  it("normalise les angles standards, négatifs et invalides", () => {
    expect(normalizeScreenOrientationAngle(0)).toBe(0);
    expect(normalizeScreenOrientationAngle(90)).toBe(90);
    expect(normalizeScreenOrientationAngle(180)).toBe(180);
    expect(normalizeScreenOrientationAngle(270)).toBe(270);
    expect(normalizeScreenOrientationAngle(-90)).toBe(270);
    expect(normalizeScreenOrientationAngle(undefined)).toBe(0);
    expect(normalizeScreenOrientationAngle(Number.NaN)).toBe(0);
  });

  it("lit screen.orientation.angle puis le repli window.orientation", () => {
    const win = createFakeWindow({ angle: 90 });
    expect(readScreenOrientationAngle(win)).toBe(90);
    expect(
      readScreenOrientationAngle({
        ...win,
        screen: undefined,
        orientation: -90,
      }),
    ).toBe(270);
  });
});

// ---------------------------------------------------------------------------
// 2. Détection SSR-safe & permission iOS / Android
// ---------------------------------------------------------------------------

describe("détection & requestGyroPermission", () => {
  it("est strictement SSR-safe sans window global", async () => {
    expect(isDeviceOrientationSupported()).toBe(false);
    expect(requiresGyroPermission()).toBe(false);
    await expect(requestGyroPermission()).resolves.toBe("unsupported");
  });

  it("retourne unsupported si DeviceOrientationEvent est absent", async () => {
    const win = createFakeWindow({ supported: false });
    expect(isDeviceOrientationSupported(win)).toBe(false);
    await expect(requestGyroPermission(win)).resolves.toBe("unsupported");
  });

  it("autorise directement sur Android / navigateur sans requestPermission", async () => {
    const win = createFakeWindow({ supported: true });
    expect(isDeviceOrientationSupported(win)).toBe(true);
    expect(requiresGyroPermission(win)).toBe(false);
    await expect(requestGyroPermission(win)).resolves.toBe("granted");
  });

  it("appelle explicitement requestPermission() sur iOS (granted / denied / throw)", async () => {
    const grantedSpy = vi.fn(async () => "granted");
    const iosGranted = createFakeWindow({ requestPermission: grantedSpy });
    expect(requiresGyroPermission(iosGranted)).toBe(true);
    await expect(requestGyroPermission(iosGranted)).resolves.toBe("granted");
    expect(grantedSpy).toHaveBeenCalledTimes(1);

    const deniedSpy = vi.fn(async () => "denied");
    const iosDenied = createFakeWindow({ requestPermission: deniedSpy });
    await expect(requestGyroPermission(iosDenied)).resolves.toBe("denied");
    expect(deniedSpy).toHaveBeenCalledTimes(1);

    const throwSpy = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const iosThrow = createFakeWindow({ requestPermission: throwSpy });
    await expect(requestGyroPermission(iosThrow)).resolves.toBe("denied");
    expect(throwSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Abonnement impératif & nettoyage batterie (`visibilitychange` / `unsubscribe`)
// ---------------------------------------------------------------------------

describe("subscribeDeviceOrientation", () => {
  it("calibre la baseline sur la 1re lecture valide puis émet des cibles impératives", () => {
    const win = createFakeWindow();
    const doc = createFakeDocument(false);
    const received: TiltTarget[] = [];

    const unsubscribe = subscribeDeviceOrientation(
      (tilt) => {
        received.push(tilt);
      },
      { window: win, document: doc, reducedMotion: false },
    );

    expect(win.orientationListeners.size).toBe(1);
    expect(doc.visibilityListeners.size).toBe(1);

    // Lecture nulle initiale ignorée
    win.emitOrientation({ beta: null, gamma: null });
    expect(received).toHaveLength(0);

    // 1re lecture valide (téléphone tenu à 45°) → baseline capturée, tilt neutre (0, 0)
    win.emitOrientation({ beta: 45, gamma: 2 });
    expect(received).toEqual([ZERO_TILT]);

    // Inclinaison droite +12° par rapport à la baseline
    win.emitOrientation({ beta: 45, gamma: 14 });
    expect(received).toHaveLength(2);
    expect(received[1]?.rx).toBe(0);
    expect(received[1]?.ry).toBeCloseTo((12 - GYRO_DEADZONE_DEG) * GYRO_GAIN, 5);

    // Nettoyage sur unsubscribe() (et idempotence)
    unsubscribe();
    unsubscribe();
    expect(win.orientationListeners.size).toBe(0);
    expect(doc.visibilityListeners.size).toBe(0);

    // Plus aucun événement émis après désabonnement
    win.emitOrientation({ beta: 20, gamma: 40 });
    expect(received).toHaveLength(2);
  });

  it("détache immédiatement les listeners lors du passage en arrière-plan (document.hidden = true)", () => {
    const win = createFakeWindow();
    const doc = createFakeDocument(false);
    const received: TiltTarget[] = [];
    const onBackgroundPause = vi.fn();

    subscribeDeviceOrientation(
      (tilt) => {
        received.push(tilt);
      },
      { window: win, document: doc, reducedMotion: false, onBackgroundPause },
    );

    win.emitOrientation({ beta: 45, gamma: 0 });
    win.emitOrientation({ beta: 30, gamma: 15 });
    expect(received).toHaveLength(2);
    expect(win.orientationListeners.size).toBe(1);

    // Passage en arrière-plan : arrêt immédiat, zéro fuite, retour au repos
    doc.setHidden(true);
    expect(win.orientationListeners.size).toBe(0);
    expect(doc.visibilityListeners.size).toBe(0);
    expect(onBackgroundPause).toHaveBeenCalledTimes(1);
    expect(received[received.length - 1]).toEqual(ZERO_TILT);

    // Même si le capteur émettait encore, rien n'est traité
    win.emitOrientation({ beta: 10, gamma: 30 });
    expect(received).toHaveLength(3);
  });

  it("n'attache aucun listener si reducedMotion est actif ou si l'onglet est déjà caché", () => {
    const win = createFakeWindow({ reducedMotion: true });
    const doc = createFakeDocument(false);
    const onTilt = vi.fn();

    const unsubReduced = subscribeDeviceOrientation(onTilt, {
      window: win,
      document: doc,
      reducedMotion: true,
    });
    expect(win.orientationListeners.size).toBe(0);
    expect(doc.visibilityListeners.size).toBe(0);
    unsubReduced();

    const hiddenDoc = createFakeDocument(true);
    const onBackgroundPause = vi.fn();
    subscribeDeviceOrientation(onTilt, {
      window: createFakeWindow({ reducedMotion: false }),
      document: hiddenDoc,
      reducedMotion: false,
      onBackgroundPause,
    });
    expect(hiddenDoc.visibilityListeners.size).toBe(0);
    expect(onBackgroundPause).toHaveBeenCalledTimes(1);
  });
});
