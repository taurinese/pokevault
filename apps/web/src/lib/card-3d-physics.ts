import { deriveHoloEffect, type HoloEffect } from "@pokevault/domain";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Inclinaison maximale autorisée sur chaque axe X / Y (en degrés). */
export const MAX_TILT_DEG = 22;

/** Raideur du ressort amorti (retour élastique fluide façon TCG Pocket). */
export const SPRING_STIFFNESS = 180;

/** Amortissement du ressort (ζ ≈ 0.75 : retour vif avec micro-rebond organique). */
export const SPRING_DAMPING = 20;

/** Seuil de repos angulaire (°) et cinétique (°/s) pour stopper la boucle rAF. */
export const REST_EPSILON = 0.02;

/** Pas de temps maximal (50 ms) pour empêcher toute divergence après un changement d'onglet. */
export const MAX_DT_SECONDS = 0.05;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inclinaison cible en degrés sur les axes X (`rotateX`) et Y (`rotateY`). */
export interface TiltTarget {
  readonly rx: number;
  readonly ry: number;
}

/** Résultat d'une interaction pointeur sur la surface 3D de la carte. */
export interface PointerTiltResult {
  readonly targetRx: number;
  readonly targetRy: number;
  /** Coordonnée horizontale du pointeur dans `[0, 100]` %. */
  readonly px: number;
  /** Coordonnée verticale du pointeur dans `[0, 100]` %. */
  readonly py: number;
}

/** État instantané du moteur ressort (angles en °, vitesses en °/s). */
export interface SpringState {
  readonly rx: number;
  readonly ry: number;
  readonly vx: number;
  readonly vy: number;
}

/** Résultat d'un pas d'intégration ressort. */
export interface SpringStepResult extends SpringState {
  /** `true` lorsque la carte est stabilisée sur sa cible (la boucle rAF peut s'arrêter). */
  readonly isAtRest: boolean;
}

/** Paramètres optionnels du ressort (injectables pour les tests ou réglages fins). */
export interface SpringConfig {
  readonly stiffness?: number | undefined;
  readonly damping?: number | undefined;
  readonly restEpsilon?: number | undefined;
}

/** Options influant sur le calcul des CSS custom properties 3D / foil. */
export interface Card3dCssVarOptions {
  readonly holoEnabled?: boolean | undefined;
  readonly reducedMotion?: boolean | undefined;
  readonly interacting?: boolean | undefined;
}

/** Ensemble des CSS custom properties pilotant les transformations 3D et couches foil. */
export interface Card3dCssVars {
  readonly "--rx": string;
  readonly "--ry": string;
  readonly "--px": string;
  readonly "--py": string;
  readonly "--bg-x": string;
  readonly "--bg-y": string;
  readonly "--glare-opacity": string;
  readonly "--hyp": string;
}

/**
 * Teinte sémantique du halo radial studio adaptatif (résolue en CSS dans `card-3d.css`
 * via `[data-halo-tone="..."]` — aucune couleur hex brute dans le JSX).
 */
export type CardHaloTone =
  | "fire"
  | "water"
  | "grass"
  | "lightning"
  | "psychic"
  | "fighting"
  | "darkness"
  | "metal"
  | "dragon"
  | "colorless"
  | "gold"
  | "tera"
  | "prismatic"
  | "neutral";

// ---------------------------------------------------------------------------
// Initial values
// ---------------------------------------------------------------------------

export const ZERO_TILT: TiltTarget = { rx: 0, ry: 0 };

export const INITIAL_SPRING_STATE: SpringState = { rx: 0, ry: 0, vx: 0, vy: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
};

/** Borne un angle d'inclinaison dans `[-MAX_TILT_DEG, +MAX_TILT_DEG]`. */
export const clampTilt = (deg: number): number => clamp(deg, -MAX_TILT_DEG, MAX_TILT_DEG);

const formatFixed = (value: number, digits = 2): string => {
  const safe = Number.isFinite(value) && Math.abs(value) >= 1e-6 ? value : 0;
  return safe.toFixed(digits);
};

const foldText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// Pointer → Tilt & Spring physics
// ---------------------------------------------------------------------------

/**
 * Convertit des coordonnées pointeur locales `(localX, localY)` dans un rectangle
 * `(width, height)` en angles cibles bornés à `±22°` et coordonnées `%` dans `[0, 100]`.
 */
export const computePointerTilt = (
  localX: number,
  localY: number,
  width: number,
  height: number,
): PointerTiltResult => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(localX) ||
    !Number.isFinite(localY)
  ) {
    return { targetRx: 0, targetRy: 0, px: 50, py: 50 };
  }

  const nx = clamp(localX / width, 0, 1);
  const ny = clamp(localY / height, 0, 1);

  const px = nx * 100;
  const py = ny * 100;

  // Haut (ny = 0) → +MAX_TILT_DEG, bas (ny = 1) → -MAX_TILT_DEG.
  // Droite (nx = 1) → +MAX_TILT_DEG, gauche (nx = 0) → -MAX_TILT_DEG.
  const targetRx = clampTilt((0.5 - ny) * 2 * MAX_TILT_DEG);
  const targetRy = clampTilt((nx - 0.5) * 2 * MAX_TILT_DEG);

  return { targetRx, targetRy, px, py };
};

/**
 * Projette une inclinaison `(rx, ry)` en position lumineuse `(px, py)` dans `[0, 100]` %.
 * Inverse exact de {@link computePointerTilt}, utile pour le retour spring et le gyroscope.
 */
export const tiltToPointerPercent = (
  rx: number,
  ry: number,
): { readonly px: number; readonly py: number } => {
  const safeRx = clampTilt(rx);
  const safeRy = clampTilt(ry);
  return {
    px: clamp(50 + (safeRy / MAX_TILT_DEG) * 50, 0, 100),
    py: clamp(50 - (safeRx / MAX_TILT_DEG) * 50, 0, 100),
  };
};

/**
 * Intègre un pas de ressort amorti par méthode d'Euler symplectique sous-échantillonnée.
 * - `dtSeconds` est borné à `MAX_DT_SECONDS` (50 ms) pour rester stable après un tab switch.
 * - Les angles de sortie restent strictement bornés à `±MAX_TILT_DEG`.
 * - Snappe proprement sur la cible (`isAtRest: true`) sous `REST_EPSILON`.
 */
export const stepSpringState = (
  state: SpringState,
  target: TiltTarget,
  dtSeconds: number,
  config?: SpringConfig | undefined,
): SpringStepResult => {
  const stiffness =
    config?.stiffness !== undefined && Number.isFinite(config.stiffness) && config.stiffness > 0
      ? config.stiffness
      : SPRING_STIFFNESS;
  const damping =
    config?.damping !== undefined && Number.isFinite(config.damping) && config.damping > 0
      ? config.damping
      : SPRING_DAMPING;
  const epsilon =
    config?.restEpsilon !== undefined &&
    Number.isFinite(config.restEpsilon) &&
    config.restEpsilon > 0
      ? config.restEpsilon
      : REST_EPSILON;

  const tx = clampTilt(target.rx);
  const ty = clampTilt(target.ry);

  let rx = clampTilt(state.rx);
  let ry = clampTilt(state.ry);
  let vx = Number.isFinite(state.vx) ? state.vx : 0;
  let vy = Number.isFinite(state.vy) ? state.vy : 0;

  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    const atRest =
      Math.abs(tx - rx) <= epsilon &&
      Math.abs(ty - ry) <= epsilon &&
      Math.abs(vx) <= epsilon &&
      Math.abs(vy) <= epsilon;
    return atRest
      ? { rx: tx, ry: ty, vx: 0, vy: 0, isAtRest: true }
      : { rx, ry, vx, vy, isAtRest: false };
  }

  const dt = Math.min(dtSeconds, MAX_DT_SECONDS);
  const substeps = dt > 0.02 ? 2 : 1;
  const h = dt / substeps;

  for (let step = 0; step < substeps; step += 1) {
    const ax = (tx - rx) * stiffness - vx * damping;
    const ay = (ty - ry) * stiffness - vy * damping;
    vx += ax * h;
    vy += ay * h;
    rx += vx * h;
    ry += vy * h;

    if (rx > MAX_TILT_DEG) {
      rx = MAX_TILT_DEG;
      if (vx > 0) vx = 0;
    } else if (rx < -MAX_TILT_DEG) {
      rx = -MAX_TILT_DEG;
      if (vx < 0) vx = 0;
    }

    if (ry > MAX_TILT_DEG) {
      ry = MAX_TILT_DEG;
      if (vy > 0) vy = 0;
    } else if (ry < -MAX_TILT_DEG) {
      ry = -MAX_TILT_DEG;
      if (vy < 0) vy = 0;
    }
  }

  const isAtRest =
    Math.abs(tx - rx) <= epsilon &&
    Math.abs(ty - ry) <= epsilon &&
    Math.abs(vx) <= epsilon &&
    Math.abs(vy) <= epsilon;

  if (isAtRest) {
    return { rx: tx, ry: ty, vx: 0, vy: 0, isAtRest: true };
  }

  return { rx, ry, vx, vy, isAtRest: false };
};

// ---------------------------------------------------------------------------
// CSS custom properties computation
// ---------------------------------------------------------------------------

/**
 * Calcule le jeu complet de CSS custom properties pilotant le rendu 3D et foil
 * sur le nœud DOM (zéro re-render React par frame).
 */
export const computeCard3dCssVars = (
  rx: number,
  ry: number,
  px: number,
  py: number,
  options?: Card3dCssVarOptions | undefined,
): Card3dCssVars => {
  const holoEnabled = options?.holoEnabled ?? true;
  const reducedMotion = options?.reducedMotion ?? false;
  const interacting = options?.interacting ?? false;

  const safeRx = reducedMotion ? 0 : clampTilt(rx);
  const safeRy = reducedMotion ? 0 : clampTilt(ry);
  const safePx = reducedMotion ? 50 : clamp(px, 0, 100);
  const safePy = reducedMotion ? 50 : clamp(py, 0, 100);

  const hyp = reducedMotion
    ? 0
    : clamp(Math.hypot(safeRx / MAX_TILT_DEG, safeRy / MAX_TILT_DEG), 0, 1);

  // Parallaxe douce des couches foil dans `[25%, 75%]` pour éviter les bords nets.
  const bgX = 25 + (safePx / 100) * 50;
  const bgY = 25 + (safePy / 100) * 50;

  let glareOpacity = 0;
  if (holoEnabled) {
    if (reducedMotion) {
      glareOpacity = 0.08;
    } else {
      const base = hyp * 0.82 + (interacting ? 0.14 : 0);
      glareOpacity = clamp(base, 0, 0.94);
    }
  }

  return {
    "--rx": `${formatFixed(safeRx, 2)}deg`,
    "--ry": `${formatFixed(safeRy, 2)}deg`,
    "--px": `${formatFixed(safePx, 2)}%`,
    "--py": `${formatFixed(safePy, 2)}%`,
    "--bg-x": `${formatFixed(bgX, 2)}%`,
    "--bg-y": `${formatFixed(bgY, 2)}%`,
    "--glare-opacity": formatFixed(glareOpacity, 3),
    "--hyp": formatFixed(hyp, 3),
  };
};

// ---------------------------------------------------------------------------
// Holo preset & adaptive halo tone resolution
// ---------------------------------------------------------------------------

export const HOLO_PRESETS: ReadonlyArray<HoloEffect> = [
  "none",
  "holo",
  "reverse",
  "ex",
  "sir",
  "tera",
  "gold",
];

const HOLO_PRESET_SET: ReadonlySet<string> = new Set(HOLO_PRESETS);

const isHoloEffect = (value: string): value is HoloEffect => HOLO_PRESET_SET.has(value);

/**
 * Normalise le preset foil 3D vers l'un des 7 presets officiels.
 * - Honore tout `holoEffect` valide (y compris `"none"` explicite).
 * - Si `holoEffect` est absent ou inconnu, déduit le preset depuis `rarity`
 *   via `deriveHoloEffect` du domaine (plus détection `"reverse"`).
 */
export const resolveHoloPreset = (
  holoEffect: HoloEffect | string | null | undefined,
  rarity?: string | null | undefined,
): HoloEffect => {
  if (typeof holoEffect === "string") {
    const normalized = foldText(holoEffect);
    if (isHoloEffect(normalized)) {
      return normalized;
    }
  }

  if (typeof rarity === "string" && rarity.trim() !== "") {
    const foldedRarity = foldText(rarity);
    if (foldedRarity.includes("reverse")) {
      return "reverse";
    }
    return deriveHoloEffect({ rarity });
  }

  return "none";
};

const TYPE_TO_HALO_TONE: Readonly<Record<string, CardHaloTone>> = {
  feu: "fire",
  fire: "fire",
  eau: "water",
  water: "water",
  plante: "grass",
  grass: "grass",
  electrique: "lightning",
  electrik: "lightning",
  lightning: "lightning",
  electric: "lightning",
  psy: "psychic",
  psychic: "psychic",
  fee: "psychic",
  fairy: "psychic",
  combat: "fighting",
  fighting: "fighting",
  obscurite: "darkness",
  tenebres: "darkness",
  darkness: "darkness",
  dark: "darkness",
  metal: "metal",
  acier: "metal",
  steel: "metal",
  dragon: "dragon",
  incolore: "colorless",
  colorless: "colorless",
  normal: "colorless",
};

/**
 * Résout le token sémantique CSS (`data-halo-tone`) du halo radial studio adaptatif
 * à partir des types Pokémon (FR/EN) ou, à défaut, de l'effet foil de la carte.
 */
export const resolveCardHaloTone = (
  types: ReadonlyArray<string> | null | undefined,
  holoEffect?: HoloEffect | string | null | undefined,
): CardHaloTone => {
  if (types !== null && types !== undefined) {
    for (const rawType of types) {
      const tone = TYPE_TO_HALO_TONE[foldText(rawType)];
      if (tone !== undefined) {
        return tone;
      }
    }
  }

  const preset = resolveHoloPreset(holoEffect);
  switch (preset) {
    case "gold":
      return "gold";
    case "tera":
      return "tera";
    case "sir":
      return "prismatic";
    default:
      return "neutral";
  }
};
