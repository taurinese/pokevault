import { describe, expect, it } from "vitest";
import { buildHealthPayload, buildHealthResponse, HEALTH_SERVICE_NAME } from "./health.ts";

const fixedDate = new Date("2026-01-02T03:04:05.678Z");

describe("health", () => {
  it("builds the payload with an ISO timestamp", () => {
    expect(buildHealthPayload(fixedDate)).toEqual({
      status: "ok",
      service: "pokevault-web",
      timestamp: "2026-01-02T03:04:05.678Z",
    });
  });

  it("returns 200 JSON with Cache-Control: no-store", async () => {
    const response = buildHealthResponse(fixedDate);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "ok",
      service: HEALTH_SERVICE_NAME,
      timestamp: fixedDate.toISOString(),
    });
  });

  it("defaults to the current time", () => {
    const before = Date.now();
    const { timestamp } = buildHealthPayload();
    const parsed = Date.parse(timestamp);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });
});
