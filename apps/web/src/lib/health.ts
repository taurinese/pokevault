export const HEALTH_SERVICE_NAME = "pokevault-web";

export interface HealthPayload {
  readonly status: "ok";
  readonly service: typeof HEALTH_SERVICE_NAME;
  readonly timestamp: string;
}

export const buildHealthPayload = (now: Date = new Date()): HealthPayload => ({
  status: "ok",
  service: HEALTH_SERVICE_NAME,
  timestamp: now.toISOString(),
});

/** `200 OK` JSON health response, never cached. */
export const buildHealthResponse = (now: Date = new Date()): Response =>
  Response.json(buildHealthPayload(now), {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
