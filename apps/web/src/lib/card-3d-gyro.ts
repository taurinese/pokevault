import { clampTilt, MAX_TILT_DEG, type TiltTarget, ZERO_TILT } from "./card-3d-physics.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Zone morte autour de la posture neutre (°) pour filtrer le micro-jitter capteur. */
export const GYRO_DEADZONE_DEG = 1.5;

/** Gain angulaire convertissant l'inclinaison réelle (°) en inclinaison carte (bornée à ±22°). */
export const GYRO_GAIN = 0.85;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lecture brute issue d'un `DeviceOrientationEvent` (`beta` tangage, `gamma` roulis). */
export interface DeviceOrientationReading {
  readonly beta: number | null;
  readonly gamma: number | null;
}

/** Posture neutre capturée à l'activation du gyroscope (ex. téléphone tenu à 45°). */
export interface GyroBaseline {
  readonly beta: number;
  readonly gamma: number;
}

/** Résultat d'une demande d'accès au gyroscope (iOS `requestPermission` ou Android direct). */
export type GyroPermissionResult = "granted" | "denied" | "unsupported";

/** Angle d'orientation écran normalisé en quarts de tour horaires. */
export type ScreenOrientationAngle = 0 | 90 | 180 | 270;

/** Interface minimale typée pour `DeviceOrientationEvent` (y compris extension iOS 13+). */
export interface DeviceOrientationEventConstructorLike {
  readonly requestPermission?: (() => Promise<string>) | undefined;
}

export interface GyroScreenLike {
  readonly orientation?: { readonly angle?: number | undefined } | undefined;
}

/** Surface minimale de `window` utilisée par le moteur gyroscope (injectable en test). */
export interface GyroWindowLike {
  readonly DeviceOrientationEvent?: DeviceOrientationEventConstructorLike | undefined;
  readonly screen?: GyroScreenLike | undefined;
  readonly orientation?: number | undefined;
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  addEventListener(
    type: "deviceorientation",
    listener: (event: DeviceOrientationReading) => void,
  ): void;
  removeEventListener(
    type: "deviceorientation",
    listener: (event: DeviceOrientationReading) => void,
  ): void;
}

/** Surface minimale de `document` utilisée pour l'arrêt batterie sur `visibilitychange`. */
export interface GyroDocumentLike {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface SubscribeDeviceOrientationOptions {
  /** Désactive le gyroscope si `prefers-reduced-motion: reduce` est actif. */
  readonly reducedMotion?: boolean | undefined;
  /** Appelé dès que l'onglet passe en arrière-plan (`document.hidden === true`). */
  readonly onBackgroundPause?: (() => void) | undefined;
  /** Dépendances injectables pour les tests unitaires sans DOM global. */
  readonly window?: GyroWindowLike | undefined;
  readonly document?: GyroDocumentLike | undefined;
}

// ---------------------------------------------------------------------------
// Helpers internes
// ---------------------------------------------------------------------------

const getBrowserWindow = (): GyroWindowLike | undefined => {
  if (typeof window === "undefined") return undefined;
  return window as unknown as GyroWindowLike;
};

const getBrowserDocument = (): GyroDocumentLike | undefined => {
  if (typeof document === "undefined") return undefined;
  return document;
};

const normalizeZero = (value: number): number => (Math.abs(value) < 1e-9 ? 0 : value);

/** Ramène un écart angulaire sur `[-180, 180]` pour éviter un saut au passage de ±180°. */
const wrapAngleDelta = (delta: number): number => {
  const wrapped = ((((delta + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
};

/** Applique une zone morte continue (sans saut à la frontière) puis le gain et le clamp ±22°. */
const applyDeadzoneAndGain = (rawDeltaDeg: number): number => {
  if (!Number.isFinite(rawDeltaDeg)) return 0;
  const magnitude = Math.abs(rawDeltaDeg);
  if (magnitude <= GYRO_DEADZONE_DEG) return 0;
  const sign = rawDeltaDeg < 0 ? -1 : 1;
  const scaled = sign * (magnitude - GYRO_DEADZONE_DEG) * GYRO_GAIN;
  return normalizeZero(clampTilt(scaled));
};

// ---------------------------------------------------------------------------
// Détection & permission (SSR-safe, iOS 13+ / Android)
// ---------------------------------------------------------------------------

/** Normalise un angle d'orientation écran quelconque (`0`, `90`, `-90`/`270`, `180`). */
export const normalizeScreenOrientationAngle = (
  angle?: number | null | undefined,
): ScreenOrientationAngle => {
  if (typeof angle !== "number" || !Number.isFinite(angle)) return 0;
  const normalized = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  return 0;
};

/** Lit l'angle d'orientation écran courant de manière SSR-safe (`screen.orientation` puis repli Safari). */
export const readScreenOrientationAngle = (
  win?: GyroWindowLike | undefined,
): ScreenOrientationAngle => {
  const target = win ?? getBrowserWindow();
  if (target === undefined) return 0;
  const modernAngle = target.screen?.orientation?.angle;
  if (typeof modernAngle === "number" && Number.isFinite(modernAngle)) {
    return normalizeScreenOrientationAngle(modernAngle);
  }
  if (typeof target.orientation === "number" && Number.isFinite(target.orientation)) {
    return normalizeScreenOrientationAngle(target.orientation);
  }
  return 0;
};

/** Vérifie de manière SSR-safe la disponibilité de `DeviceOrientationEvent`. */
export const isDeviceOrientationSupported = (win?: GyroWindowLike | undefined): boolean => {
  const target = win ?? getBrowserWindow();
  if (target === undefined) return false;
  return typeof target.DeviceOrientationEvent !== "undefined";
};

/** Indique si le navigateur exige une permission explicite sur geste utilisateur (iOS ≥ 13). */
export const requiresGyroPermission = (win?: GyroWindowLike | undefined): boolean => {
  const target = win ?? getBrowserWindow();
  if (target === undefined) return false;
  const ctor = target.DeviceOrientationEvent;
  return ctor !== undefined && typeof ctor.requestPermission === "function";
};

/**
 * Demande l'autorisation d'accès au gyroscope :
 * - SSR / navigateur sans `DeviceOrientationEvent` → `"unsupported"` ;
 * - iOS (≥ 13) avec `DeviceOrientationEvent.requestPermission()` → attend la réponse
 *   et renvoie `"granted"` ou `"denied"` (jamais d'exception non attrapée) ;
 * - Android / navigateurs sans `requestPermission` → `"granted"` directement.
 */
export const requestGyroPermission = async (
  win?: GyroWindowLike | undefined,
): Promise<GyroPermissionResult> => {
  const target = win ?? getBrowserWindow();
  if (target === undefined || target.DeviceOrientationEvent === undefined) {
    return "unsupported";
  }

  const requestPermission = target.DeviceOrientationEvent.requestPermission;
  if (typeof requestPermission !== "function") {
    return "granted";
  }

  try {
    const result = await requestPermission.call(target.DeviceOrientationEvent);
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
};

/** Détecte `prefers-reduced-motion: reduce` côté client (toujours `false` en SSR). */
export const isReducedMotionPreferred = (win?: GyroWindowLike | undefined): boolean => {
  const target = win ?? getBrowserWindow();
  if (target === undefined || typeof target.matchMedia !== "function") return false;
  return target.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

// ---------------------------------------------------------------------------
// Conversion pure orientation capteur → TiltTarget (`±22°`)
// ---------------------------------------------------------------------------

/**
 * Convertit une lecture `DeviceOrientationEvent` (`beta`, `gamma`) relative à une
 * posture neutre `baseline` en cible d'inclinaison 3D `{ rx, ry }` bornée à `±22°`.
 *
 * - Ignore toute lecture incomplète (`null`) ou non finie (`NaN`, `Infinity`) → `null`.
 * - Lorsque `baseline` vaut `null` (1re lecture valide), considère cette posture
 *   comme neutre et renvoie `{ rx: 0, ry: 0 }`.
 * - Adapte les axes à la rotation d'écran (`0`, `90`, `-90`/`270`, `180`).
 * - Applique une deadzone continue (`GYRO_DEADZONE_DEG`) et un gain calibré (`GYRO_GAIN`),
 *   puis borne strictement sur `[-MAX_TILT_DEG, +MAX_TILT_DEG]`.
 */
export const orientationToTilt = (
  reading: DeviceOrientationReading,
  baseline: GyroBaseline | null,
  screenOrientationAngle?: number,
): TiltTarget | null => {
  if (
    reading.beta === null ||
    reading.gamma === null ||
    !Number.isFinite(reading.beta) ||
    !Number.isFinite(reading.gamma)
  ) {
    return null;
  }

  if (baseline === null) {
    return ZERO_TILT;
  }

  if (!Number.isFinite(baseline.beta) || !Number.isFinite(baseline.gamma)) {
    return null;
  }

  const deltaBeta = wrapAngleDelta(reading.beta - baseline.beta);
  const deltaGamma = reading.gamma - baseline.gamma;
  const angle = normalizeScreenOrientationAngle(screenOrientationAngle);

  // Projection des axes physiques du téléphone sur les axes visuels de la carte :
  // - Portrait (0°) : incliner le haut vers l'arrière (deltaBeta < 0) → rx > 0 ;
  //   incliner vers la droite (deltaGamma > 0) → ry > 0.
  // - Paysage 90° / 180° / 270° (-90°) : rotation orthogonale correspondante.
  let rawRx = 0;
  let rawRy = 0;
  switch (angle) {
    case 90:
      rawRx = deltaGamma;
      rawRy = deltaBeta;
      break;
    case 180:
      rawRx = deltaBeta;
      rawRy = -deltaGamma;
      break;
    case 270:
      rawRx = -deltaGamma;
      rawRy = -deltaBeta;
      break;
    default:
      rawRx = -deltaBeta;
      rawRy = deltaGamma;
      break;
  }

  const rx = applyDeadzoneAndGain(rawRx);
  const ry = applyDeadzoneAndGain(rawRy);

  return {
    rx: Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, rx)),
    ry: Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, ry)),
  };
};

// ---------------------------------------------------------------------------
// Abonnement impératif (zéro re-render React 60 Hz + nettoyage batterie)
// ---------------------------------------------------------------------------

/**
 * Abonne un callback impératif aux événements `deviceorientation` (zéro `useState` par frame).
 *
 * - Capture automatiquement la posture initiale (`baseline`) sur la 1re lecture valide.
 * - Refuse de s'abonner si `reducedMotion` est actif ou si l'API n'est pas supportée.
 * - Détache immédiatement les listeners dès la mise en arrière-plan de l'onglet
 *   (`visibilitychange` lorsque `document.hidden === true`) ou lors de l'appel à la
 *   fonction de nettoyage retournée (idempotente).
 */
export const subscribeDeviceOrientation = (
  onTilt: (tilt: TiltTarget) => void,
  options?: SubscribeDeviceOrientationOptions | undefined,
): (() => void) => {
  const win = options?.window ?? getBrowserWindow();
  const doc = options?.document ?? getBrowserDocument();
  const reducedMotion = options?.reducedMotion ?? isReducedMotionPreferred(win);

  if (reducedMotion || win === undefined || !isDeviceOrientationSupported(win)) {
    return () => undefined;
  }

  if (doc?.hidden) {
    options?.onBackgroundPause?.();
    return () => undefined;
  }

  let active = true;
  let baseline: GyroBaseline | null = null;
  let lastScreenAngle = readScreenOrientationAngle(win);

  const handleOrientation = (event: DeviceOrientationReading): void => {
    if (!active) return;
    if (
      event.beta === null ||
      event.gamma === null ||
      !Number.isFinite(event.beta) ||
      !Number.isFinite(event.gamma)
    ) {
      return;
    }

    const screenAngle = readScreenOrientationAngle(win);
    if (baseline === null || screenAngle !== lastScreenAngle) {
      lastScreenAngle = screenAngle;
      baseline = { beta: event.beta, gamma: event.gamma };
      onTilt(ZERO_TILT);
      return;
    }

    const tilt = orientationToTilt(event, baseline, screenAngle);
    if (tilt !== null) {
      onTilt(tilt);
    }
  };

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    baseline = null;
    win.removeEventListener("deviceorientation", handleOrientation);
    if (doc !== undefined) {
      doc.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };

  const handleVisibilityChange = (): void => {
    if (!active) return;
    if (doc?.hidden) {
      cleanup();
      onTilt(ZERO_TILT);
      options?.onBackgroundPause?.();
    }
  };

  win.addEventListener("deviceorientation", handleOrientation);
  if (doc !== undefined) {
    doc.addEventListener("visibilitychange", handleVisibilityChange);
  }

  return cleanup;
};
