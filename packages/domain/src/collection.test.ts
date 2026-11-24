import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  aggregateCopiesByCard,
  Binder,
  BinderConflictError,
  BinderCoverType,
  BinderKind,
  BinderNotFoundError,
  binderCoverStoragePath,
  buildCollectionOverview,
  CardCopyNotFoundError,
  COVER_MAX_BYTES,
  type CompletionCopy,
  CreateCustomBinderInput,
  CreateSetBinderInput,
  computeGlobalCompletion,
  computePercent,
  computeSeriesCompletion,
  computeSetCompletion,
  copySlotKey,
  decodeUpdateCardCopyInput,
  decodeUpsertCardCopyInput,
  detectCoverImageFormat,
  GradingCompany,
  InvalidCoverImageError,
  isBinderCoverStoragePathOf,
  isUuid,
  MAX_CARD_COPY_QUANTITY,
  normalizeBinderTitle,
  SetBinderCoverInput,
  type SetCompletionEntry,
  StorageServiceError,
  UnauthorizedBinderAccess,
  UpdateBinderInput,
  UpdateCardCopyInput,
  UpsertCardCopyInput,
  UserCardCopy,
  ValidationError,
} from "./index.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const BINDER = "22222222-2222-4222-8222-222222222222";
const ts = "2026-01-01T00:00:00.000Z";

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown): A =>
  Schema.decodeUnknownSync(schema)(input);
const rejects = <A, I>(schema: Schema.Codec<A, I>, input: unknown): boolean => {
  try {
    Schema.decodeUnknownSync(schema)(input);
    return false;
  } catch {
    return true;
  }
};

describe("literal schemas", () => {
  it("accepte uniquement les valeurs de la migration 004", () => {
    expect(decode(BinderKind, "set")).toBe("set");
    expect(decode(BinderKind, "custom")).toBe("custom");
    expect(rejects(BinderKind, "shared")).toBe(true);
    expect(decode(BinderCoverType, "upload")).toBe("upload");
    expect(rejects(BinderCoverType, "gif")).toBe(true);
    for (const company of ["PSA", "PCA", "BGS", "CGC"]) {
      expect(decode(GradingCompany, company)).toBe(company);
    }
    expect(rejects(GradingCompany, "psa")).toBe(true);
  });
});

describe("Binder", () => {
  const binder = {
    id: BINDER,
    userId: USER,
    kind: "set",
    setId: "sv08",
    title: "Étincelles Déferlantes",
    coverType: "set_logo",
    coverCardId: null,
    coverStoragePath: null,
    isPinned: false,
    sortOrder: 0,
    createdAt: ts,
    updatedAt: ts,
  };

  it("décode une ligne valide", () => {
    expect(decode(Binder, binder).title).toBe("Étincelles Déferlantes");
  });

  it("rejette un titre vide, blanc, non trimé ou > 80 caractères", () => {
    expect(rejects(Binder, { ...binder, title: "" })).toBe(true);
    expect(rejects(Binder, { ...binder, title: "   " })).toBe(true);
    expect(rejects(Binder, { ...binder, title: " Favs" })).toBe(true);
    expect(rejects(Binder, { ...binder, title: "x".repeat(81) })).toBe(true);
    expect(decode(Binder, { ...binder, title: "x".repeat(80) }).title).toHaveLength(80);
  });
});

describe("inputs de classeur", () => {
  it("CreateSetBinderInput : titre et ifExists facultatifs", () => {
    expect(decode(CreateSetBinderInput, { setId: "sv08" })).toEqual({ setId: "sv08" });
    expect(decode(CreateSetBinderInput, { setId: "sv08", ifExists: "fail" }).ifExists).toBe("fail");
    expect(rejects(CreateSetBinderInput, { setId: "" })).toBe(true);
    expect(rejects(CreateSetBinderInput, { setId: "sv 08" })).toBe(true);
    expect(rejects(CreateSetBinderInput, { setId: "sv08", ifExists: "maybe" })).toBe(true);
  });

  it("CreateCustomBinderInput : titre obligatoire", () => {
    expect(decode(CreateCustomBinderInput, { title: "Doublons Échange" }).title).toBe(
      "Doublons Échange",
    );
    expect(rejects(CreateCustomBinderInput, {})).toBe(true);
    expect(rejects(CreateCustomBinderInput, { title: "  " })).toBe(true);
  });

  it("UpdateBinderInput : au moins un champ, types stricts", () => {
    expect(decode(UpdateBinderInput, { isPinned: true })).toEqual({ isPinned: true });
    expect(decode(UpdateBinderInput, { sortOrder: -3 }).sortOrder).toBe(-3);
    expect(rejects(UpdateBinderInput, {})).toBe(true);
    expect(rejects(UpdateBinderInput, { sortOrder: 1.5 })).toBe(true);
    expect(rejects(UpdateBinderInput, { title: "" })).toBe(true);
  });

  it("SetBinderCoverInput : trois variantes discriminées", () => {
    expect(decode(SetBinderCoverInput, { type: "set_logo" }).type).toBe("set_logo");
    expect(decode(SetBinderCoverInput, { type: "card", cardId: "sv08-238" })).toEqual({
      type: "card",
      cardId: "sv08-238",
    });
    expect(decode(SetBinderCoverInput, { type: "upload", image: new Uint8Array([1]) }).type).toBe(
      "upload",
    );
    expect(rejects(SetBinderCoverInput, { type: "card" })).toBe(true);
    expect(rejects(SetBinderCoverInput, { type: "upload", image: "not-bytes" })).toBe(true);
    expect(rejects(SetBinderCoverInput, { type: "url", url: "https://x" })).toBe(true);
  });
});

describe("UserCardCopy / inputs d'exemplaires", () => {
  const copy = {
    id: BINDER,
    userId: USER,
    cardId: "sv03.5-199",
    language: "FR",
    variant: "holo",
    condition: "NM",
    quantity: 2,
    purchasePriceCents: 1250,
    gradingCompany: null,
    gradingScore: null,
    notes: null,
    acquiredAt: "2026-02-03",
    createdAt: ts,
    updatedAt: ts,
  };

  it("décode une copie valide, gradée ou non", () => {
    expect(decode(UserCardCopy, copy).quantity).toBe(2);
    expect(
      decode(UserCardCopy, { ...copy, gradingCompany: "PSA", gradingScore: "9.5" }).gradingScore,
    ).toBe("9.5");
  });

  it("borne la quantité à 1..MAX_CARD_COPY_QUANTITY", () => {
    expect(decode(UserCardCopy, { ...copy, quantity: MAX_CARD_COPY_QUANTITY }).quantity).toBe(999);
    expect(rejects(UserCardCopy, { ...copy, quantity: 0 })).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, quantity: -1 })).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, quantity: 1000 })).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, quantity: 1.5 })).toBe(true);
  });

  it("rejette un prix d'achat négatif ou non entier", () => {
    expect(decode(UserCardCopy, { ...copy, purchasePriceCents: 0 }).purchasePriceCents).toBe(0);
    expect(rejects(UserCardCopy, { ...copy, purchasePriceCents: -1 })).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, purchasePriceCents: 9.99 })).toBe(true);
  });

  it("exige société ET note de grading ensemble, sans espaces de bord", () => {
    expect(rejects(UserCardCopy, { ...copy, gradingCompany: "PSA" })).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, gradingScore: "10" })).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, gradingCompany: "PSA", gradingScore: " 10" })).toBe(
      true,
    );
    expect(rejects(UserCardCopy, { ...copy, gradingCompany: "PSA", gradingScore: "10 " })).toBe(
      true,
    );
    expect(rejects(UserCardCopy, { ...copy, gradingCompany: "PSA", gradingScore: "" })).toBe(true);
    expect(
      rejects(UserCardCopy, { ...copy, gradingCompany: "PSA", gradingScore: "1".repeat(17) }),
    ).toBe(true);
    expect(rejects(UserCardCopy, { ...copy, gradingCompany: "ABC", gradingScore: "10" })).toBe(
      true,
    );
  });

  it("rejette des notes > 1000 caractères", () => {
    expect(rejects(UserCardCopy, { ...copy, notes: "n".repeat(1001) })).toBe(true);
    expect(decode(UserCardCopy, { ...copy, notes: "n".repeat(1000) }).notes).toHaveLength(1000);
  });

  it("UpsertCardCopyInput : défauts facultatifs, validations", () => {
    expect(decode(UpsertCardCopyInput, { cardId: "sv08-1", variant: "normal" })).toEqual({
      cardId: "sv08-1",
      variant: "normal",
    });
    expect(rejects(UpsertCardCopyInput, { cardId: "sv08-1" })).toBe(true);
    expect(rejects(UpsertCardCopyInput, { cardId: "sv 08", variant: "normal" })).toBe(true);
    expect(rejects(UpsertCardCopyInput, { cardId: "sv08-1", variant: "normal", quantity: 0 })).toBe(
      true,
    );
    expect(
      rejects(UpsertCardCopyInput, { cardId: "sv08-1", variant: "normal", quantity: 1000 }),
    ).toBe(true);
    expect(
      rejects(UpsertCardCopyInput, {
        cardId: "sv08-1",
        variant: "normal",
        purchasePriceCents: -5,
      }),
    ).toBe(true);
    expect(
      rejects(UpsertCardCopyInput, { cardId: "sv08-1", variant: "normal", gradingCompany: "PSA" }),
    ).toBe(true);
    expect(
      decode(UpsertCardCopyInput, {
        cardId: "sv08-1",
        variant: "normal",
        gradingCompany: "PCA",
        gradingScore: "10",
      }).gradingCompany,
    ).toBe("PCA");
    expect(
      rejects(UpsertCardCopyInput, {
        cardId: "sv08-1",
        variant: "normal",
        gradingCompany: "PCA",
        gradingScore: " 10",
      }),
    ).toBe(true);
  });

  it("UpdateCardCopyInput : au moins un champ, grading cohérent, null autorisé", () => {
    expect(rejects(UpdateCardCopyInput, {})).toBe(true);
    expect(decode(UpdateCardCopyInput, { notes: null }).notes).toBeNull();
    expect(decode(UpdateCardCopyInput, { purchasePriceCents: null }).purchasePriceCents).toBeNull();
    expect(rejects(UpdateCardCopyInput, { gradingCompany: "PSA" })).toBe(true);
    expect(rejects(UpdateCardCopyInput, { gradingScore: "10" })).toBe(true);
    expect(rejects(UpdateCardCopyInput, { gradingCompany: "PSA", gradingScore: null })).toBe(true);
    expect(rejects(UpdateCardCopyInput, { gradingCompany: null, gradingScore: "10" })).toBe(true);
    expect(
      decode(UpdateCardCopyInput, { gradingCompany: null, gradingScore: null }).gradingCompany,
    ).toBeNull();
    expect(
      decode(UpdateCardCopyInput, { gradingCompany: "BGS", gradingScore: "9.5" }).gradingScore,
    ).toBe("9.5");
    expect(rejects(UpdateCardCopyInput, { condition: "XX" })).toBe(true);
    expect(rejects(UpdateCardCopyInput, { purchasePriceCents: -1 })).toBe(true);
  });

  it("decodeUpsert/UpdateCardCopyInput : ValidationError typée", async () => {
    const bad = await Effect.runPromise(
      Effect.flip(decodeUpsertCardCopyInput({ cardId: "x", variant: "nope" })),
    );
    expect(bad).toBeInstanceOf(ValidationError);
    const badPatch = await Effect.runPromise(Effect.flip(decodeUpdateCardCopyInput({})));
    expect(badPatch._tag).toBe("ValidationError");
    const ok = await Effect.runPromise(decodeUpdateCardCopyInput({ notes: "ok" }));
    expect(ok.notes).toBe("ok");
  });
});

describe("erreurs typées", () => {
  it("portent un _tag stable et leurs champs", () => {
    expect(new BinderNotFoundError({ binderId: BINDER, message: "x" })._tag).toBe(
      "BinderNotFoundError",
    );
    expect(new BinderConflictError({ message: "x", setId: "sv08" }).setId).toBe("sv08");
    expect(new UnauthorizedBinderAccess({ message: "x" })._tag).toBe("UnauthorizedBinderAccess");
    expect(new CardCopyNotFoundError({ copyId: "c", message: "x" }).copyId).toBe("c");
    expect(new InvalidCoverImageError({ reason: "too_large", message: "x" }).reason).toBe(
      "too_large",
    );
    expect(new StorageServiceError({ message: "x", status: 503 }).status).toBe(503);
  });
});

describe("chemin cover & détection d'image", () => {
  it("binderCoverStoragePath = <userId>/<binderId>.webp (minuscules)", () => {
    expect(binderCoverStoragePath(USER, BINDER)).toBe(`${USER}/${BINDER}.webp`);
    expect(binderCoverStoragePath(USER.toUpperCase(), BINDER.toUpperCase())).toBe(
      `${USER}/${BINDER}.webp`,
    );
  });

  it("isBinderCoverStoragePathOf refuse tout autre chemin", () => {
    const path = binderCoverStoragePath(USER, BINDER);
    expect(isBinderCoverStoragePathOf(path, USER, BINDER)).toBe(true);
    expect(isBinderCoverStoragePathOf(`${USER}/${BINDER}.png`, USER, BINDER)).toBe(false);
    expect(isBinderCoverStoragePathOf(`${BINDER}/${BINDER}.webp`, USER, BINDER)).toBe(false);
    expect(isBinderCoverStoragePathOf(`${USER}/../${BINDER}.webp`, USER, BINDER)).toBe(false);
    expect(isBinderCoverStoragePathOf(`${USER}/${BINDER}.webp/x`, USER, BINDER)).toBe(false);
    expect(isBinderCoverStoragePathOf(`${USER}//${BINDER}.webp`, USER, BINDER)).toBe(false);
    expect(isBinderCoverStoragePathOf(path.toUpperCase(), USER, BINDER)).toBe(false);
  });

  it("isUuid", () => {
    expect(isUuid(USER)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(`${USER}x`)).toBe(false);
  });

  it("detectCoverImageFormat identifie JPEG / PNG / WebP / SVG / inconnu", () => {
    expect(detectCoverImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(
      detectCoverImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe("png");
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(detectCoverImageFormat(webp)).toBe("webp");
    const wav = new Uint8Array(12);
    wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectCoverImageFormat(wav)).toBe("unknown");
    const enc = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    expect(detectCoverImageFormat(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("svg");
    expect(detectCoverImageFormat(enc('  \n<?xml version="1.0"?><svg/>'))).toBe("svg");
    expect(detectCoverImageFormat(enc("<SVG/>"))).toBe("svg");
    expect(detectCoverImageFormat(enc("GIF89a"))).toBe("unknown");
    expect(detectCoverImageFormat(new Uint8Array())).toBe("unknown");
    expect(detectCoverImageFormat(new Uint8Array([0xff, 0xd8]))).toBe("unknown");
  });

  it("COVER_MAX_BYTES = 2 Mio", () => {
    expect(COVER_MAX_BYTES).toBe(2_097_152);
  });

  it("normalizeBinderTitle", () => {
    expect(normalizeBinderTitle("  Évolitions   Favs ")).toBe("Évolitions Favs");
  });
});

describe("aggregateCopiesByCard / copySlotKey", () => {
  it("agrège quantités, doublons, variantes (ordre canonique) et slots par carte", () => {
    const result = aggregateCopiesByCard([
      { cardId: "a", variant: "holo", quantity: 2 },
      { cardId: "b", variant: "normal", quantity: 1 },
      { cardId: "a", variant: "normal", quantity: 1 },
      { cardId: "a", variant: "holo", quantity: 3 },
      { cardId: "c", variant: "reverse", quantity: 0 },
    ]);
    expect(result).toEqual([
      {
        cardId: "a",
        totalQuantity: 6,
        duplicateCount: 5,
        variants: ["normal", "holo"],
        slotCount: 3,
      },
      { cardId: "b", totalQuantity: 1, duplicateCount: 0, variants: ["normal"], slotCount: 1 },
    ]);
    expect(aggregateCopiesByCard([])).toEqual([]);
  });

  it("copySlotKey ignore null vs absent et distingue les slots", () => {
    const base = {
      cardId: "a",
      language: "FR",
      variant: "holo",
      condition: "NM",
    } as const;
    expect(copySlotKey(base)).toBe(
      copySlotKey({ ...base, gradingCompany: null, gradingScore: null }),
    );
    expect(copySlotKey(base)).not.toBe(copySlotKey({ ...base, condition: "EX" }));
    expect(copySlotKey(base)).not.toBe(
      copySlotKey({ ...base, gradingCompany: "PSA", gradingScore: "10" }),
    );
    expect(copySlotKey({ ...base, gradingCompany: "PSA", gradingScore: "10" })).not.toBe(
      copySlotKey({ ...base, gradingCompany: "PSA", gradingScore: "9" }),
    );
  });
});

describe("computePercent", () => {
  it("0 si total <= 0 ou rien de possédé", () => {
    expect(computePercent(0, 100)).toBe(0);
    expect(computePercent(5, 0)).toBe(0);
    expect(computePercent(5, -1)).toBe(0);
  });
  it("arrondit au plus proche", () => {
    expect(computePercent(1, 3)).toBe(33);
    expect(computePercent(2, 3)).toBe(67);
    expect(computePercent(1, 2)).toBe(50);
  });
  it("ne renvoie 100 que si complet, et jamais 0 dès une carte", () => {
    expect(computePercent(999, 1000)).toBe(99);
    expect(computePercent(995, 1000)).toBe(99);
    expect(computePercent(1, 1000)).toBe(1);
    expect(computePercent(1000, 1000)).toBe(100);
    expect(computePercent(1200, 1000)).toBe(100);
  });
});

describe("computeSetCompletion", () => {
  const set = { setId: "sv08", officialCount: 10, totalCount: 13 };
  const copy = (
    cardId: string,
    quantity: number,
    localIdNumeric: number | null,
    variant: CompletionCopy["variant"] = "normal",
  ): CompletionCopy => ({ cardId, quantity, localIdNumeric, variant });

  it("set vide : not_started, 0 %", () => {
    const stats = computeSetCompletion(set, []);
    expect(stats).toMatchObject({
      setId: "sv08",
      officialCount: 10,
      totalCount: 13,
      targetCount: 13,
      ownedDistinct: 0,
      missingCount: 13,
      percent: 0,
      totalCopies: 0,
      duplicateCount: 0,
      duplicateCardCount: 0,
      status: "not_started",
    });
  });

  it("partiel : in_progress, cartes distinctes, copies et doublons", () => {
    const stats = computeSetCompletion(set, [
      copy("c1", 2, 1),
      copy("c1", 1, 1, "holo"),
      copy("c2", 1, 2),
      copy("c3", 4, 3),
    ]);
    expect(stats.ownedDistinct).toBe(3);
    expect(stats.totalCopies).toBe(8);
    expect(stats.duplicateCount).toBe(2 + 3);
    expect(stats.duplicateCardCount).toBe(2);
    expect(stats.missingCount).toBe(10);
    expect(stats.percent).toBe(23);
    expect(stats.status).toBe("in_progress");
  });

  it("complet : toutes les cartes (secrètes incluses) → completed 100 %", () => {
    const all = Array.from({ length: 13 }, (_, index) => copy(`c${index + 1}`, 1, index + 1));
    const stats = computeSetCompletion(set, all);
    expect(stats).toMatchObject({ ownedDistinct: 13, percent: 100, status: "completed" });
    expect(stats.missingCount).toBe(0);
  });

  it("includeSecrets=false : dénominateur = officialCount, secrètes ignorées", () => {
    const official = Array.from({ length: 10 }, (_, index) => copy(`c${index + 1}`, 1, index + 1));
    const withSecrets = [...official, copy("s1", 1, 11), copy("s2", 3, 13)];
    const stats = computeSetCompletion(set, withSecrets, { includeSecrets: false });
    expect(stats).toMatchObject({
      targetCount: 10,
      ownedDistinct: 10,
      totalCopies: 10,
      duplicateCount: 0,
      percent: 100,
      status: "completed",
    });
    const only = computeSetCompletion(set, [copy("s1", 1, 11)], { includeSecrets: false });
    expect(only.status).toBe("not_started");
    expect(only.ownedDistinct).toBe(0);
    // avec secrètes : les mêmes cartes comptent
    expect(computeSetCompletion(set, withSecrets).ownedDistinct).toBe(12);
  });

  it("une carte sans numéro local n'est jamais considérée secrète", () => {
    const stats = computeSetCompletion(set, [copy("x", 1, null)], { includeSecrets: false });
    expect(stats.ownedDistinct).toBe(1);
  });

  it("includePromos=false : ignore les exemplaires promo", () => {
    const copies = [
      copy("c1", 1, 1, "promo"),
      copy("c2", 1, 2, "normal"),
      copy("c2", 2, 2, "promo"),
    ];
    const without = computeSetCompletion(set, copies, { includePromos: false });
    expect(without.ownedDistinct).toBe(1);
    expect(without.totalCopies).toBe(1);
    const withPromos = computeSetCompletion(set, copies);
    expect(withPromos.ownedDistinct).toBe(2);
    expect(withPromos.totalCopies).toBe(4);
  });

  it("ignore les quantités <= 0", () => {
    const stats = computeSetCompletion(set, [copy("c1", 0, 1), copy("c2", -2, 2)]);
    expect(stats.ownedDistinct).toBe(0);
    expect(stats.status).toBe("not_started");
  });

  it("normalise des compteurs incohérents (total < official)", () => {
    const stats = computeSetCompletion({ setId: "x", officialCount: 5, totalCount: 2 }, []);
    expect(stats.totalCount).toBe(5);
    expect(stats.targetCount).toBe(5);
  });

  it("extension sans carte (total 0) : jamais completed", () => {
    const stats = computeSetCompletion({ setId: "x", officialCount: 0, totalCount: 0 }, [
      copy("c1", 1, 1),
    ]);
    expect(stats.status).toBe("in_progress");
    expect(stats.percent).toBe(0);
    expect(stats.missingCount).toBe(0);
  });

  it("possession > total : plafonnée à 100 %, completed", () => {
    const stats = computeSetCompletion({ setId: "x", officialCount: 1, totalCount: 1 }, [
      copy("a", 1, 1),
      copy("b", 1, null),
    ]);
    expect(stats.percent).toBe(100);
    expect(stats.status).toBe("completed");
    expect(stats.missingCount).toBe(0);
  });
});

describe("computeSeriesCompletion / computeGlobalCompletion", () => {
  const stats = (
    setId: string,
    owned: number,
    target: number,
    copies = owned,
    dup = copies - owned,
    dupCards = dup > 0 ? 1 : 0,
  ): SetCompletionEntry["stats"] => ({
    setId,
    officialCount: target,
    totalCount: target,
    targetCount: target,
    ownedDistinct: owned,
    missingCount: Math.max(0, target - owned),
    percent: computePercent(owned, target),
    totalCopies: copies,
    duplicateCount: dup,
    duplicateCardCount: dupCards,
    status: owned === 0 ? "not_started" : owned >= target ? "completed" : "in_progress",
  });
  const entries: ReadonlyArray<SetCompletionEntry> = [
    { stats: stats("a", 10, 10, 12), tracked: true },
    { stats: stats("b", 5, 20, 5), tracked: true },
    { stats: stats("c", 0, 8), tracked: true },
    { stats: stats("d", 3, 100, 6, 3, 2), tracked: false },
  ];

  it("série : agrège uniquement les extensions suivies", () => {
    const series = computeSeriesCompletion("sv", entries);
    expect(series).toEqual({
      seriesId: "sv",
      setCount: 4,
      trackedSetCount: 3,
      completedSetCount: 1,
      ownedDistinct: 15,
      targetCount: 38,
      percent: 39,
      totalCopies: 17,
      duplicateCount: 2,
    });
  });

  it("série vide : 0 partout", () => {
    expect(computeSeriesCompletion("x", [])).toMatchObject({
      setCount: 0,
      trackedSetCount: 0,
      completedSetCount: 0,
      ownedDistinct: 0,
      targetCount: 0,
      percent: 0,
    });
  });

  it("série entièrement complète : 100 %", () => {
    const series = computeSeriesCompletion("x", [{ stats: stats("a", 4, 4), tracked: true }]);
    expect(series).toMatchObject({ percent: 100, completedSetCount: 1 });
  });

  it("global : % sur les suivis, totaux sur toute la collection", () => {
    expect(computeGlobalCompletion(entries)).toEqual({
      trackedSetCount: 3,
      completedSetCount: 1,
      trackedOwnedDistinct: 15,
      trackedTargetCount: 38,
      percent: 39,
      ownedDistinct: 18,
      totalCopies: 23,
      duplicateCount: 5,
      duplicateCardCount: 3,
    });
  });

  it("global vide", () => {
    expect(computeGlobalCompletion([])).toEqual({
      trackedSetCount: 0,
      completedSetCount: 0,
      trackedOwnedDistinct: 0,
      trackedTargetCount: 0,
      percent: 0,
      ownedDistinct: 0,
      totalCopies: 0,
      duplicateCount: 0,
      duplicateCardCount: 0,
    });
  });
});

describe("buildCollectionOverview", () => {
  const series = [
    { id: "swsh", nameFr: "Épée et Bouclier", releaseOrder: 11 },
    { id: "sv", nameFr: "Écarlate et Violet", releaseOrder: 12 },
    { id: "xy", nameFr: "XY", releaseOrder: 6 },
  ];
  const mk = (id: string, seriesId: string, date: string, official: number, total: number) => ({
    id,
    seriesId,
    nameFr: id.toUpperCase(),
    code: id,
    logoUrl: null,
    releaseDate: date,
    officialCount: official,
    totalCount: total,
  });
  const sets = [
    mk("sv08", "sv", "2024-11-08", 3, 4),
    mk("sv03.5", "sv", "2023-09-22", 2, 2),
    mk("swsh12", "swsh", "2022-11-11", 5, 6),
    mk("xy1", "xy", "2014-02-05", 10, 10),
  ];
  const copy = (setId: string, cardId: string, quantity: number, localIdNumeric: number) => ({
    setId,
    cardId,
    quantity,
    localIdNumeric,
    variant: "normal" as const,
  });

  it("regroupe par série, ne garde que les extensions suivies ou possédées, trie par récence", () => {
    const overview = buildCollectionOverview({
      series,
      sets,
      trackedSetIds: new Set(["sv08", "swsh12"]),
      copies: [
        copy("sv08", "sv08-1", 2, 1),
        copy("sv08", "sv08-2", 1, 2),
        copy("sv03.5", "sv03.5-1", 1, 1),
        copy("sv03.5", "sv03.5-2", 1, 2),
      ],
    });
    expect(overview.sets.map((set) => [set.setId, set.tracked])).toEqual([
      ["sv08", true],
      ["sv03.5", false],
      ["swsh12", true],
    ]);
    expect(overview.sets[1]?.completion.status).toBe("completed");
    expect(overview.series.map((entry) => entry.seriesId)).toEqual(["sv", "swsh"]);
    expect(overview.series[0]?.completion).toMatchObject({
      setCount: 2,
      trackedSetCount: 1,
      ownedDistinct: 2,
      targetCount: 4,
      percent: 50,
      duplicateCount: 1,
    });
    expect(overview.global).toMatchObject({
      trackedSetCount: 2,
      trackedOwnedDistinct: 2,
      trackedTargetCount: 10,
      percent: 20,
      ownedDistinct: 4,
      totalCopies: 5,
      duplicateCount: 1,
    });
  });

  it("propage les options secrètes / promos", () => {
    const overview = buildCollectionOverview(
      {
        series,
        sets,
        trackedSetIds: new Set(["sv08"]),
        copies: [copy("sv08", "sv08-4", 1, 4)],
      },
      { includeSecrets: false },
    );
    expect(overview.sets[0]?.completion).toMatchObject({ targetCount: 3, ownedDistinct: 0 });
  });

  it("vide", () => {
    const overview = buildCollectionOverview({
      series,
      sets,
      trackedSetIds: new Set(),
      copies: [],
    });
    expect(overview.sets).toEqual([]);
    expect(overview.series).toEqual([]);
    expect(overview.global.percent).toBe(0);
  });
});
