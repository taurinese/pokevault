import { SqlDate } from "@pokevault/domain";
import { Context, Data, Effect, Layer, Schedule, Schema } from "effect";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * HTTP / network failure of a TCGdex v2 call. `status` is `0` for transport
 * level failures (DNS, socket, timeout). `retryable` drives the retry policy:
 * only `429` and `5xx` (plus transport errors) are retried.
 */
export class TcgdexHttpError extends Data.TaggedError("TcgdexHttpError")<{
  readonly url: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly body: string | null;
  readonly cause?: unknown;
}> {}

/** The response body was not the expected JSON payload for the endpoint. */
export class TcgdexDecodeError extends Data.TaggedError("TcgdexDecodeError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

export type TcgdexError = TcgdexHttpError | TcgdexDecodeError;

// ---------------------------------------------------------------------------
// TCGdex v2 payload schemas (verified against https://api.tcgdex.net/v2)
// ---------------------------------------------------------------------------

export type TcgdexLanguage = "fr" | "en";

const NonEmpty = Schema.NonEmptyString;

/** `GET /v2/{lang}/series` item. */
export const TcgdexSeriesSummary = Schema.Struct({
  id: NonEmpty,
  name: Schema.String,
  logo: Schema.optional(Schema.String),
});
export type TcgdexSeriesSummary = typeof TcgdexSeriesSummary.Type;

/** `cardCount` object present on set summaries / details. */
export const TcgdexCardCount = Schema.Struct({
  firstEd: Schema.optional(Schema.Int),
  holo: Schema.optional(Schema.Int),
  normal: Schema.optional(Schema.Int),
  official: Schema.optional(Schema.Int),
  reverse: Schema.optional(Schema.Int),
  total: Schema.optional(Schema.Int),
});
export type TcgdexCardCount = typeof TcgdexCardCount.Type;

/** `GET /v2/{lang}/sets` item. */
export const TcgdexSetSummary = Schema.Struct({
  id: NonEmpty,
  name: Schema.String,
  logo: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  cardCount: Schema.optional(TcgdexCardCount),
});
export type TcgdexSetSummary = typeof TcgdexSetSummary.Type;

/** Card entry embedded in `GET /v2/{lang}/sets/{id}`. */
export const TcgdexSetCardSummary = Schema.Struct({
  id: NonEmpty,
  localId: NonEmpty,
  name: Schema.String,
  image: Schema.optional(Schema.String),
});
export type TcgdexSetCardSummary = typeof TcgdexSetCardSummary.Type;

/** `GET /v2/{lang}/sets/{id}` — full set with its card list. */
export const TcgdexSetDetail = Schema.Struct({
  id: NonEmpty,
  name: Schema.String,
  logo: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  releaseDate: Schema.optional(SqlDate),
  cardCount: Schema.optional(TcgdexCardCount),
  serie: Schema.Struct({
    id: NonEmpty,
    name: Schema.optional(Schema.String),
  }),
  abbreviation: Schema.optional(
    Schema.Struct({
      official: Schema.optional(Schema.String),
      localized: Schema.optional(Schema.String),
    }),
  ),
  cards: Schema.optional(Schema.Array(TcgdexSetCardSummary)),
});
export type TcgdexSetDetail = typeof TcgdexSetDetail.Type;

export const TcgdexAbility = Schema.Struct({
  type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  effect: Schema.optional(Schema.String),
});

export const TcgdexAttack = Schema.Struct({
  name: Schema.optional(Schema.String),
  effect: Schema.optional(Schema.String),
  /** TCGdex emits both `"60+"` and plain numbers (`330`). */
  damage: Schema.optional(Schema.Union([Schema.String, Schema.Int])),
  cost: Schema.optional(Schema.Array(Schema.String)),
});

/** `variants` summary of `GET /v2/{lang}/cards/{id}`. */
export const TcgdexCardVariants = Schema.Struct({
  normal: Schema.optional(Schema.Boolean),
  reverse: Schema.optional(Schema.Boolean),
  holo: Schema.optional(Schema.Boolean),
  firstEdition: Schema.optional(Schema.Boolean),
  wPromo: Schema.optional(Schema.Boolean),
});

/** `GET /v2/{lang}/cards/{id}` — full card. */
export const TcgdexCardDetail = Schema.Struct({
  id: NonEmpty,
  localId: NonEmpty,
  name: Schema.String,
  image: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  rarity: Schema.optional(Schema.String),
  hp: Schema.optional(Schema.Int),
  types: Schema.optional(Schema.Array(Schema.String)),
  stage: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
  illustrator: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  abilities: Schema.optional(Schema.Array(TcgdexAbility)),
  attacks: Schema.optional(Schema.Array(TcgdexAttack)),
  variants: Schema.optional(TcgdexCardVariants),
  pricing: Schema.optional(
    Schema.Struct({
      cardmarket: Schema.optional(
        Schema.Struct({
          idProduct: Schema.optional(Schema.Int),
        }),
      ),
    }),
  ),
  set: Schema.optional(
    Schema.Struct({
      id: NonEmpty,
    }),
  ),
});
export type TcgdexCardDetail = typeof TcgdexCardDetail.Type;

// ---------------------------------------------------------------------------
// Client service
// ---------------------------------------------------------------------------

export interface TcgdexClientShape {
  readonly listSeries: (
    lang: TcgdexLanguage,
  ) => Effect.Effect<ReadonlyArray<TcgdexSeriesSummary>, TcgdexError>;
  readonly listSets: (
    lang: TcgdexLanguage,
  ) => Effect.Effect<ReadonlyArray<TcgdexSetSummary>, TcgdexError>;
  readonly getSet: (
    lang: TcgdexLanguage,
    setId: string,
  ) => Effect.Effect<TcgdexSetDetail, TcgdexError>;
  readonly getCard: (
    lang: TcgdexLanguage,
    cardId: string,
  ) => Effect.Effect<TcgdexCardDetail, TcgdexError>;
}

/** Effect-TS service key of the TCGdex v2 HTTP client. */
export class TcgdexClient extends Context.Service<TcgdexClient, TcgdexClientShape>()(
  "@pokevault/services/TcgdexClient",
) {}

/**
 * Low-level transport: resolves with the raw response body. Injectable so
 * tests run 100 % offline against fixtures.
 */
export type TcgdexTransport = (url: string) => Effect.Effect<string, TcgdexHttpError>;

/** Maximum wait between two retries (each delay is capped, not the total elapsed time). */
export const TCGDEX_MAX_RETRY_DELAY = "5 seconds";

/**
 * Retry schedule: jittered exponential backoff (200 ms, 400 ms, ...) whose
 * *per-retry* delay is capped at {@link TCGDEX_MAX_RETRY_DELAY} (the cap is
 * applied after the jitter, so the bound is strict). The number of
 * retries is bounded separately (`times`), so a long request timeout can never
 * cancel the remaining retries.
 */
export const tcgdexRetrySchedule = Schedule.min([
  Schedule.jittered(Schedule.exponential("200 millis")),
  Schedule.spaced(TCGDEX_MAX_RETRY_DELAY),
]);

export interface TcgdexClientConfig {
  /** e.g. `https://api.tcgdex.net/v2`. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds (default 10 000). */
  readonly timeoutMs?: number | undefined;
  /** Maximum number of retries on retryable failures (default 5). */
  readonly maxRetries?: number | undefined;
  /** Injectable transport, defaults to the global `fetch`. */
  readonly transport?: TcgdexTransport | undefined;
}

export const DEFAULT_TCGDEX_BASE_URL = "https://api.tcgdex.net/v2";
export const DEFAULT_TCGDEX_TIMEOUT_MS = 10_000;
export const DEFAULT_TCGDEX_MAX_RETRIES = 5;

/**
 * Real transport backed by the global `fetch` (Node >= 18). The Effect
 * `AbortSignal` is forwarded to `fetch`, so `Effect.timeout` (or any fiber
 * interruption) really aborts the HTTP request and releases the socket.
 */
export const fetchTransport = (timeoutMs: number): TcgdexTransport => {
  const transport: TcgdexTransport = (url) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          signal,
          headers: { accept: "application/json" },
        });
        const body = await response.text();
        if (!response.ok) {
          throw new TcgdexHttpError({
            url,
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
            body: body.length > 500 ? `${body.slice(0, 500)}…` : body,
          });
        }
        return body;
      },
      catch: (cause): TcgdexHttpError =>
        cause instanceof TcgdexHttpError
          ? cause
          : new TcgdexHttpError({ url, status: 0, retryable: true, body: null, cause }),
    }).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError(
        (error): TcgdexHttpError =>
          error instanceof TcgdexHttpError
            ? error
            : new TcgdexHttpError({ url, status: 0, retryable: true, body: null, cause: error }),
      ),
    );
  return transport;
};

/**
 * Builds a {@link TcgdexClientShape} from a config. Every request is decoded
 * through an `Effect.Schema` at the boundary and retried with a jittered
 * exponential backoff (per-retry delay capped) on retryable HTTP failures only.
 */
export const makeTcgdexClient = (config: TcgdexClientConfig): TcgdexClientShape => {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TCGDEX_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_TCGDEX_MAX_RETRIES;
  const transport = config.transport ?? fetchTransport(timeoutMs);

  const request = <S extends Schema.Constraint>(
    schema: S,
    path: string,
  ): Effect.Effect<S["Type"], TcgdexError, S["DecodingServices"]> => {
    const url = `${baseUrl}/${path}`;
    // `Effect.suspend` so every retry re-invokes the transport (fresh HTTP call).
    const raw = Effect.suspend(() => transport(url)).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () => JSON.parse(body) as unknown,
          catch: (cause) => new TcgdexDecodeError({ url, cause }),
        }),
      ),
      Effect.flatMap((value: unknown) => Schema.decodeUnknownEffect(schema)(value)),
      Effect.mapError((error): TcgdexError => {
        if (error instanceof TcgdexHttpError || error instanceof TcgdexDecodeError) return error;
        return new TcgdexDecodeError({ url, cause: error });
      }),
    );
    return Effect.retry(raw, {
      while: (error) => error._tag === "TcgdexHttpError" && error.retryable,
      times: maxRetries,
      schedule: tcgdexRetrySchedule,
    });
  };

  return {
    listSeries: (lang) => request(Schema.Array(TcgdexSeriesSummary), `${lang}/series`),
    listSets: (lang) => request(Schema.Array(TcgdexSetSummary), `${lang}/sets`),
    getSet: (lang, setId) => request(TcgdexSetDetail, `${lang}/sets/${encodeURIComponent(setId)}`),
    getCard: (lang, cardId) =>
      request(TcgdexCardDetail, `${lang}/cards/${encodeURIComponent(cardId)}`),
  };
};

/** Live layer of {@link TcgdexClient} over the global `fetch`. */
export const TcgdexClientLive = (config: TcgdexClientConfig): Layer.Layer<TcgdexClient> =>
  Layer.succeed(TcgdexClient, makeTcgdexClient(config));
