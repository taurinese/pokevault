import { COVER_MAX_DIMENSION, InvalidCoverImageError } from "@pokevault/domain";
import { Effect, Layer } from "effect";
import {
  CoverImageProcessor,
  type CoverImageProcessorShape,
  validateCoverImage,
  validateCoverOutput,
} from "./cover-image.ts";

/**
 * Implémentation `sharp` de {@link CoverImageProcessor}.
 *
 * ⚠️ Module volontairement ABSENT de `index.ts` : `sharp` est un addon natif qui ne peut pas
 * être inliné dans le bundle ESM auto-suffisant du worker (Rolldown). Seul l'app web
 * (Node, `node_modules` complets via `pnpm deploy --prod`) l'importe, via le sous-chemin
 * `@pokevault/services/cover-image-sharp`. `sharp` est de plus chargé par `import()`
 * dynamique, à la première recompression.
 */

/** Pixels décodés max (anti « decompression bomb » : un PNG de 2 Mio peut valoir des Gpx). */
const MAX_INPUT_PIXELS = 25_000_000;

const WEBP_QUALITY = 82;

let sharpCacheConfigured = false;
const loadSharp = async () => {
  const sharp = (await import("sharp")).default;
  if (!sharpCacheConfigured) {
    sharp.cache(false);
    sharpCacheConfigured = true;
  }
  return sharp;
};

const recompress = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const sharp = await loadSharp();
  // `.rotate()` applique l'orientation EXIF puis l'efface ; sans `.withMetadata()`, sharp
  // supprime tout le reste (EXIF, GPS, XMP, ICC non essentiel).
  const output = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(COVER_MAX_DIMENSION, COVER_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
};

const sharpShape: CoverImageProcessorShape = {
  process: (bytes) =>
    validateCoverImage(bytes).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () => recompress(bytes),
          catch: (cause) =>
            new InvalidCoverImageError({
              reason: "corrupt",
              message: "image could not be decoded",
              cause,
            }),
        }),
      ),
      Effect.flatMap(validateCoverOutput),
    ),
};

/** Layer `sharp` de {@link CoverImageProcessor} (WebP ≤ 600×600, sans EXIF, ≤ 2 Mio). */
export const CoverImageProcessorSharp: Layer.Layer<CoverImageProcessor> = Layer.succeed(
  CoverImageProcessor,
  sharpShape,
);
