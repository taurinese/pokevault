import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COVER_MAX_BYTES, COVER_MAX_DIMENSION, detectCoverImageFormat } from "@pokevault/domain";
import { Effect } from "effect";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  CoverImageProcessor,
  CoverImageProcessorMemory,
  validateCoverImage,
  validateCoverOutput,
} from "./cover-image.ts";
import { CoverImageProcessorSharp } from "./cover-image-sharp.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));
const processWith = (layer: typeof CoverImageProcessorSharp, bytes: Uint8Array) =>
  run(
    Effect.flatMap(CoverImageProcessor, (processor) => processor.process(bytes)).pipe(
      Effect.provide(layer),
    ),
  );

const gradient = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  });

const toBytes = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const png = async (width = 800, height = 1100) =>
  toBytes(await gradient(width, height).png().toBuffer());
const jpeg = async (width = 800, height = 1100) =>
  toBytes(await gradient(width, height).jpeg().toBuffer());
const webp = async (width = 800, height = 1100) =>
  toBytes(await gradient(width, height).webp().toBuffer());

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("validateCoverImage (avant tout encodeur)", () => {
  it("accepte JPEG / PNG / WebP réels", async () => {
    expect(await run(validateCoverImage(await jpeg(20, 20)))).toMatchObject({ _tag: "Success" });
    const asPng = await run(validateCoverImage(await png(20, 20)));
    expect(asPng._tag === "Success" && asPng.success).toBe("png");
    const asWebp = await run(validateCoverImage(await webp(20, 20)));
    expect(asWebp._tag === "Success" && asWebp.success).toBe("webp");
  });

  it("refuse un SVG explicitement", async () => {
    const result = await run(
      validateCoverImage(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    );
    expect(result._tag === "Failure" && result.failure).toMatchObject({
      _tag: "InvalidCoverImageError",
      reason: "svg_not_allowed",
    });
  });

  it("refuse GIF / PDF / texte / contenu vide", async () => {
    for (const sample of [bytesOf("GIF89a....."), bytesOf("%PDF-1.7"), bytesOf("hello")]) {
      const result = await run(validateCoverImage(sample));
      expect(result._tag === "Failure" && result.failure).toMatchObject({
        reason: "unsupported_format",
      });
    }
    const empty = await run(validateCoverImage(new Uint8Array()));
    expect(empty._tag === "Failure" && empty.failure).toMatchObject({ reason: "empty" });
  });

  it("refuse > 2 Mio, même avec une signature valide", async () => {
    const big = new Uint8Array(COVER_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    const result = await run(validateCoverImage(big));
    expect(result._tag === "Failure" && result.failure).toMatchObject({ reason: "too_large" });
    const exact = new Uint8Array(COVER_MAX_BYTES);
    exact.set([0xff, 0xd8, 0xff]);
    expect((await run(validateCoverImage(exact)))._tag).toBe("Success");
  });

  it("validateCoverOutput exige un WebP non vide ≤ 2 Mio", async () => {
    expect((await run(validateCoverOutput(await webp(10, 10))))._tag).toBe("Success");
    expect((await run(validateCoverOutput(await png(10, 10))))._tag).toBe("Failure");
    expect((await run(validateCoverOutput(new Uint8Array())))._tag).toBe("Failure");
  });
});

describe("CoverImageProcessorSharp", () => {
  it("PNG large → WebP ≤ 600×600, ratio conservé (fit inside)", async () => {
    const result = await processWith(CoverImageProcessorSharp, await png(1200, 1800));
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(detectCoverImageFormat(result.success)).toBe("webp");
    const meta = await sharp(result.success).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(COVER_MAX_DIMENSION);
  });

  it("JPEG et WebP en entrée sont recompressés en WebP", async () => {
    for (const input of [await jpeg(900, 700), await webp(900, 700)]) {
      const result = await processWith(CoverImageProcessorSharp, input);
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      const meta = await sharp(result.success).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(COVER_MAX_DIMENSION);
      expect(meta.height).toBe(467);
    }
  });

  it("n'agrandit jamais une petite image (withoutEnlargement)", async () => {
    const result = await processWith(CoverImageProcessorSharp, await png(120, 80));
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const meta = await sharp(result.success).metadata();
    expect([meta.width, meta.height]).toEqual([120, 80]);
  });

  it("supprime EXIF (GPS, appareil) des JPEG et applique l'orientation", async () => {
    const withExif = toBytes(
      await gradient(300, 200)
        .jpeg()
        .withMetadata({
          orientation: 6,
          exif: {
            IFD0: { Make: "SecretCamera", Copyright: "private" },
            IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 0/1" },
          },
        })
        .toBuffer(),
    );
    const before = await sharp(withExif).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    expect(Buffer.from(withExif).includes("SecretCamera")).toBe(true);

    const result = await processWith(CoverImageProcessorSharp, withExif);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const after = await sharp(result.success).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(Buffer.from(result.success).includes("SecretCamera")).toBe(false);
    expect(Buffer.from(result.success).includes("EXIF")).toBe(false);
    // orientation 6 (rotation 90°) appliquée : 300×200 devient 200×300
    expect([after.width, after.height]).toEqual([200, 300]);
    expect(after.orientation).toBeUndefined();
  });

  it("refuse un SVG, un fichier trop gros et un faux JPEG corrompu sans appeler sharp", async () => {
    const svg = await processWith(CoverImageProcessorSharp, bytesOf("<svg/>"));
    expect(svg._tag === "Failure" && svg.failure).toMatchObject({ reason: "svg_not_allowed" });

    const big = new Uint8Array(COVER_MAX_BYTES + 10);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tooBig = await processWith(CoverImageProcessorSharp, big);
    expect(tooBig._tag === "Failure" && tooBig.failure).toMatchObject({ reason: "too_large" });

    const fake = new Uint8Array(256);
    fake.set([0xff, 0xd8, 0xff, 0xe0]);
    const corrupt = await processWith(CoverImageProcessorSharp, fake);
    expect(corrupt._tag === "Failure" && corrupt.failure).toMatchObject({ reason: "corrupt" });
  });

  it("une image massive (≥ 40 Mpx) est refusée (decompression bomb)", async () => {
    const bomb = toBytes(
      await sharp({
        create: { width: 9000, height: 5000, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
    expect(bomb.length).toBeLessThan(COVER_MAX_BYTES);
    const result = await processWith(CoverImageProcessorSharp, bomb);
    expect(result._tag === "Failure" && result.failure).toMatchObject({ reason: "corrupt" });
  });
});

describe("CoverImageProcessorMemory", () => {
  it("valide puis renvoie un faux WebP", async () => {
    const ok = await processWith(CoverImageProcessorMemory, await png(10, 10));
    expect(ok._tag === "Success" && detectCoverImageFormat(ok.success)).toBe("webp");
    const bad = await processWith(CoverImageProcessorMemory, bytesOf("<svg/>"));
    expect(bad._tag).toBe("Failure");
  });
});

describe("garde-fou bundle worker (Rolldown)", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );

  it("seul cover-image-sharp.ts importe `sharp`, et index.ts ne l'exporte pas", () => {
    const importing = sources.filter((file) =>
      /(?:from|import\()\s*["']sharp["']/.test(readFileSync(join(dir, file), "utf8")),
    );
    expect(importing).toEqual(["cover-image-sharp.ts"]);
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    expect(index).not.toMatch(/cover-image-sharp/);
    // aucun module atteignable depuis index.ts n'importe cover-image-sharp
    const importers = sources.filter((file) =>
      /from\s+["']\.\/cover-image-sharp\.ts["']/.test(readFileSync(join(dir, file), "utf8")),
    );
    expect(importers.filter((file) => file !== "cover-image-sharp.ts")).toEqual([]);
  });
});
