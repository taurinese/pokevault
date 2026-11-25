import { describe, expect, it } from "vitest";
import {
  clampTilt,
  computeCard3dCssVars,
  computePointerTilt,
  HOLO_PRESETS,
  INITIAL_SPRING_STATE,
  MAX_DT_SECONDS,
  MAX_TILT_DEG,
  REST_EPSILON,
  resolveCardHaloTone,
  resolveHoloPreset,
  stepSpringState,
  tiltToPointerPercent,
  ZERO_TILT,
} from "./card-3d-physics.ts";

describe("computePointerTilt", () => {
  it("retourne un angle nul et (50 %, 50 %) au centre exact de la carte", () => {
    const result = computePointerTilt(150, 200, 300, 400);
    expect(result.targetRx).toBeCloseTo(0, 6);
    expect(result.targetRy).toBeCloseTo(0, 6);
    expect(result.px).toBeCloseTo(50, 6);
    expect(result.py).toBeCloseTo(50, 6);
  });

  it("borne strictement l'inclinaison à ±22° et px/py dans [0, 100] % sur les coins et hors cadre", () => {
    const topLeft = computePointerTilt(0, 0, 300, 400);
    expect(topLeft).toEqual({ targetRx: MAX_TILT_DEG, targetRy: -MAX_TILT_DEG, px: 0, py: 0 });

    const bottomRight = computePointerTilt(300, 400, 300, 400);
    expect(bottomRight).toEqual({
      targetRx: -MAX_TILT_DEG,
      targetRy: MAX_TILT_DEG,
      px: 100,
      py: 100,
    });

    const farOutside = computePointerTilt(9999, -5000, 300, 400);
    expect(farOutside).toEqual({
      targetRx: MAX_TILT_DEG,
      targetRy: MAX_TILT_DEG,
      px: 100,
      py: 0,
    });

    const farOpposite = computePointerTilt(-999, 9999, 300, 400);
    expect(farOpposite).toEqual({
      targetRx: -MAX_TILT_DEG,
      targetRy: -MAX_TILT_DEG,
      px: 0,
      py: 100,
    });
  });

  it("gère proprement les dimensions nulles, négatives ou non finies", () => {
    expect(computePointerTilt(10, 20, 0, 400)).toEqual({
      targetRx: 0,
      targetRy: 0,
      px: 50,
      py: 50,
    });
    expect(computePointerTilt(Number.NaN, 20, 300, 400)).toEqual({
      targetRx: 0,
      targetRy: 0,
      px: 50,
      py: 50,
    });
    expect(computePointerTilt(10, Number.POSITIVE_INFINITY, 300, -10)).toEqual({
      targetRx: 0,
      targetRy: 0,
      px: 50,
      py: 50,
    });
  });
});

describe("tiltToPointerPercent & clampTilt", () => {
  it("est l'inverse exact de computePointerTilt dans le domaine valide", () => {
    const tilt = computePointerTilt(225, 100, 300, 400);
    const pct = tiltToPointerPercent(tilt.targetRx, tilt.targetRy);
    expect(pct.px).toBeCloseTo(tilt.px, 5);
    expect(pct.py).toBeCloseTo(tilt.py, 5);
  });

  it("borne les angles hors limites et NaN", () => {
    expect(clampTilt(90)).toBe(MAX_TILT_DEG);
    expect(clampTilt(-90)).toBe(-MAX_TILT_DEG);
    expect(clampTilt(Number.NaN)).toBe(0);
  });
});

describe("stepSpringState", () => {
  it("converge vers (0, 0) au relâchement et signale isAtRest = true", () => {
    let state = stepSpringState({ rx: 22, ry: -18, vx: 0, vy: 0 }, ZERO_TILT, 1 / 60);
    expect(state.isAtRest).toBe(false);

    let frames = 1;
    while (!state.isAtRest && frames < 300) {
      state = stepSpringState(state, ZERO_TILT, 1 / 60);
      expect(Math.abs(state.rx)).toBeLessThanOrEqual(MAX_TILT_DEG);
      expect(Math.abs(state.ry)).toBeLessThanOrEqual(MAX_TILT_DEG);
      frames += 1;
    }

    expect(state.isAtRest).toBe(true);
    expect(state.rx).toBe(0);
    expect(state.ry).toBe(0);
    expect(state.vx).toBe(0);
    expect(state.vy).toBe(0);
    expect(frames).toBeLessThan(180);
  });

  it("converge vers une cible non nulle bornée à ±22°", () => {
    let state = INITIAL_SPRING_STATE;
    const target = { rx: 40, ry: -35 }; // volontairement hors bornes → clampé à ±22°
    let isAtRest = false;

    for (let i = 0; i < 240; i += 1) {
      const next = stepSpringState(state, target, 1 / 60);
      state = next;
      isAtRest = next.isAtRest;
      expect(Math.abs(next.rx)).toBeLessThanOrEqual(MAX_TILT_DEG);
      expect(Math.abs(next.ry)).toBeLessThanOrEqual(MAX_TILT_DEG);
      if (isAtRest) break;
    }

    expect(isAtRest).toBe(true);
    expect(state.rx).toBe(MAX_TILT_DEG);
    expect(state.ry).toBe(-MAX_TILT_DEG);
  });

  it("reste parfaitement stable sur un gros dt (ex. retour après changement d'onglet)", () => {
    const start = { rx: 20, ry: -20, vx: 45, vy: -30 };
    const hugeDt = stepSpringState(start, ZERO_TILT, 12);
    const clampedDt = stepSpringState(start, ZERO_TILT, MAX_DT_SECONDS);

    expect(Number.isFinite(hugeDt.rx)).toBe(true);
    expect(Number.isFinite(hugeDt.ry)).toBe(true);
    expect(Math.abs(hugeDt.rx)).toBeLessThanOrEqual(MAX_TILT_DEG);
    expect(Math.abs(hugeDt.ry)).toBeLessThanOrEqual(MAX_TILT_DEG);
    expect(hugeDt).toEqual(clampedDt);
  });

  it("gère dt <= 0 et un état déjà au repos sous REST_EPSILON", () => {
    const idle = stepSpringState(INITIAL_SPRING_STATE, ZERO_TILT, 0);
    expect(idle.isAtRest).toBe(true);
    expect(idle.rx).toBe(0);
    expect(idle.ry).toBe(0);

    const nearRest = stepSpringState(
      { rx: REST_EPSILON / 2, ry: -REST_EPSILON / 2, vx: 0, vy: 0 },
      ZERO_TILT,
      -0.01,
    );
    expect(nearRest.isAtRest).toBe(true);
    expect(nearRest.rx).toBe(0);
    expect(nearRest.ry).toBe(0);
  });
});

describe("computeCard3dCssVars", () => {
  it("calcule des CSS custom properties déterministes au repos et en inclinaison", () => {
    const rest = computeCard3dCssVars(0, 0, 50, 50);
    expect(rest).toEqual({
      "--rx": "0.00deg",
      "--ry": "0.00deg",
      "--px": "50.00%",
      "--py": "50.00%",
      "--bg-x": "50.00%",
      "--bg-y": "50.00%",
      "--glare-opacity": "0.000",
      "--hyp": "0.000",
    });

    const tilted = computeCard3dCssVars(11, -22, 0, 25, { interacting: true });
    expect(tilted["--rx"]).toBe("11.00deg");
    expect(tilted["--ry"]).toBe("-22.00deg");
    expect(tilted["--px"]).toBe("0.00%");
    expect(tilted["--py"]).toBe("25.00%");
    expect(tilted["--bg-x"]).toBe("25.00%");
    expect(tilted["--bg-y"]).toBe("37.50%");
    expect(Number.parseFloat(tilted["--hyp"])).toBeGreaterThan(0.9);
    expect(Number.parseFloat(tilted["--glare-opacity"])).toBeGreaterThan(0.8);
  });

  it("coupe la brillance lorsque holoEnabled = false", () => {
    const vars = computeCard3dCssVars(15, 15, 80, 20, { holoEnabled: false, interacting: true });
    expect(vars["--glare-opacity"]).toBe("0.000");
    expect(vars["--rx"]).toBe("15.00deg");
  });

  it("neutralise le tilt et réduit fortement les reflets en mode reducedMotion", () => {
    const vars = computeCard3dCssVars(22, -22, 95, 10, { reducedMotion: true, interacting: true });
    expect(vars).toEqual({
      "--rx": "0.00deg",
      "--ry": "0.00deg",
      "--px": "50.00%",
      "--py": "50.00%",
      "--bg-x": "50.00%",
      "--bg-y": "50.00%",
      "--glare-opacity": "0.080",
      "--hyp": "0.000",
    });

    const reducedNoHolo = computeCard3dCssVars(22, -22, 95, 10, {
      reducedMotion: true,
      holoEnabled: false,
    });
    expect(reducedNoHolo["--glare-opacity"]).toBe("0.000");
  });
});

describe("resolveHoloPreset", () => {
  it("reconnaît et normalise les 7 presets HoloEffect", () => {
    for (const preset of HOLO_PRESETS) {
      expect(resolveHoloPreset(preset)).toBe(preset);
      expect(resolveHoloPreset(`  ${preset.toUpperCase()} `)).toBe(preset);
    }
    expect(HOLO_PRESETS).toHaveLength(7);
  });

  it("honore un holoEffect explicite (y compris 'none') même si rarity est fournie", () => {
    expect(resolveHoloPreset("none", "Illustration Spéciale Rare")).toBe("none");
    expect(resolveHoloPreset("gold", "Commune")).toBe("gold");
  });

  it("déduit le preset depuis la rareté FR/EN quand holoEffect est absent ou inconnu", () => {
    expect(resolveHoloPreset(undefined, "Illustration Spéciale Rare")).toBe("sir");
    expect(resolveHoloPreset(null, "Hyper Rare")).toBe("gold");
    expect(resolveHoloPreset("unknown", "Téracristal")).toBe("tera");
    expect(resolveHoloPreset(undefined, "Double Rare")).toBe("ex");
    expect(resolveHoloPreset(undefined, "Rare Holo")).toBe("holo");
    expect(resolveHoloPreset(undefined, "Reverse")).toBe("reverse");
    expect(resolveHoloPreset(undefined, "Commune")).toBe("none");
    expect(resolveHoloPreset(undefined, undefined)).toBe("none");
  });
});

describe("resolveCardHaloTone", () => {
  it("mappe les types Pokémon FR & EN (accents inclus) vers un token sémantique CSS", () => {
    expect(resolveCardHaloTone(["Feu"])).toBe("fire");
    expect(resolveCardHaloTone(["Water"])).toBe("water");
    expect(resolveCardHaloTone(["Plante"])).toBe("grass");
    expect(resolveCardHaloTone(["Électrique"])).toBe("lightning");
    expect(resolveCardHaloTone(["Psy"])).toBe("psychic");
    expect(resolveCardHaloTone(["Fée"])).toBe("psychic");
    expect(resolveCardHaloTone(["Combat"])).toBe("fighting");
    expect(resolveCardHaloTone(["Obscurité"])).toBe("darkness");
    expect(resolveCardHaloTone(["Métal"])).toBe("metal");
    expect(resolveCardHaloTone(["Dragon"])).toBe("dragon");
    expect(resolveCardHaloTone(["Incolore"])).toBe("colorless");
  });

  it("se replie sur le preset foil ou neutral quand la carte n'a pas de type Pokémon", () => {
    expect(resolveCardHaloTone([], "gold")).toBe("gold");
    expect(resolveCardHaloTone(null, "tera")).toBe("tera");
    expect(resolveCardHaloTone(undefined, "sir")).toBe("prismatic");
    expect(resolveCardHaloTone(["Inconnu"], "holo")).toBe("neutral");
    expect(resolveCardHaloTone(undefined, "none")).toBe("neutral");
  });
});
