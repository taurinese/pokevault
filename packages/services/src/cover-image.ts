import {
  COVER_MAX_BYTES,
  COVER_MAX_DIMENSION,
  detectCoverImageFormat,
  InvalidCoverImageError,
} from "@pokevault/domain";
import { Context, Effect, Layer } from "effect";

// ---------------------------------------------------------------------------
// Validation avant tout appel à l'encodeur (docs/06 §3)
// ---------------------------------------------------------------------------

/**
 * Valide une image de cover **avant** de la confier à un décodeur : non vide, `<= 2 Mio`,
 * magic bytes JPEG / PNG / WebP uniquement (SVG et tout autre format refusés explicitement).
 * Fonction pure, sans dépendance native.
 */
export const validateCoverImage = (
  bytes: Uint8Array,
): Effect.Effect<"jpeg" | "png" | "webp", InvalidCoverImageError> => {
  if (bytes.length === 0) {
    return Effect.fail(new InvalidCoverImageError({ reason: "empty", message: "image is empty" }));
  }
  if (bytes.length > COVER_MAX_BYTES) {
    return Effect.fail(
      new InvalidCoverImageError({
        reason: "too_large",
        message: `image is ${bytes.length} bytes, max is ${COVER_MAX_BYTES} (2 MiB)`,
      }),
    );
  }
  const format = detectCoverImageFormat(bytes);
  if (format === "svg") {
    return Effect.fail(
      new InvalidCoverImageError({
        reason: "svg_not_allowed",
        message: "SVG images are not allowed (XSS risk): use JPEG, PNG or WebP",
      }),
    );
  }
  if (format === "unknown") {
    return Effect.fail(
      new InvalidCoverImageError({
        reason: "unsupported_format",
        message: "unsupported image format: use JPEG, PNG or WebP",
      }),
    );
  }
  return Effect.succeed(format);
};

/** Vérifie qu'une sortie d'encodeur est bien un WebP `<= 2 Mio`. */
export const validateCoverOutput = (
  bytes: Uint8Array,
): Effect.Effect<Uint8Array, InvalidCoverImageError> =>
  detectCoverImageFormat(bytes) === "webp" && bytes.length > 0 && bytes.length <= COVER_MAX_BYTES
    ? Effect.succeed(bytes)
    : Effect.fail(
        new InvalidCoverImageError({
          reason: bytes.length > COVER_MAX_BYTES ? "too_large" : "corrupt",
          message: "re-encoded cover is not a valid WebP within the 2 MiB limit",
        }),
      );

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Pipeline de recompression des covers : image brute (JPEG / PNG / WebP validée) →
 * WebP `<= 600×600` sans EXIF / GPS, `<= 2 Mio`.
 *
 * L'implémentation `sharp` vit dans `./cover-image-sharp.ts` (export dédié
 * `@pokevault/services/cover-image-sharp`) : ce module-ci reste 100 % JS pour que le bundle
 * Rolldown du worker n'embarque jamais de binaire natif.
 */
export interface CoverImageProcessorShape {
  readonly process: (bytes: Uint8Array) => Effect.Effect<Uint8Array, InvalidCoverImageError>;
}

/** Effect-TS service key of the cover image processor. */
export class CoverImageProcessor extends Context.Service<
  CoverImageProcessor,
  CoverImageProcessorShape
>()("@pokevault/services/CoverImageProcessor") {}

/**
 * Processeur de test : applique la même validation que la version `sharp` puis renvoie
 * un faux WebP déterministe (`RIFF....WEBP` + `marker`), sans décodage d'image. Respecte
 * donc `COVER_MAX_DIMENSION` uniquement par contrat.
 */
export const CoverImageProcessorMemory: Layer.Layer<CoverImageProcessor> = Layer.succeed(
  CoverImageProcessor,
  {
    process: (bytes) =>
      validateCoverImage(bytes).pipe(
        Effect.map(() => {
          const out = new Uint8Array(16);
          out.set([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
          out.set([0x6d, 0x65, 0x6d, COVER_MAX_DIMENSION & 0xff], 12);
          return out;
        }),
      ),
  },
);
