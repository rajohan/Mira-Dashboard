import * as v from "valibot";

import { livenessStatusSchema, readinessStatusSchema } from "../../contracts/system.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import type { ReadinessState } from "../platform/readiness/readinessState.ts";

/** HTTP methods supported by health probes. */
export type HealthProbeMethod = "GET" | "HEAD";

function healthResponse(
    method: HealthProbeMethod,
    payload: { status: "live" | "not-ready" | "ready" },
    statusCode: 200 | 503
): Response {
    const body = JSON.stringify(payload);
    return new Response(method === "HEAD" ? null : body, {
        headers: {
            "content-length": String(utf8ByteLength(body)),
            "content-type": "application/json",
        },
        status: statusCode,
    });
}

/**
 * Handles the liveness protocol route.
 * @param method Probe request method.
 * @returns A validated liveness response with a body only for GET.
 */
export function livenessResponse(method: HealthProbeMethod): Response {
    return healthResponse(method, v.parse(livenessStatusSchema, { status: "live" }), 200);
}

/**
 * Handles the readiness protocol route.
 * @param method Probe request method.
 * @param readiness Current application readiness state.
 * @returns A validated 200 or 503 readiness response with a body only for GET.
 */
export function readinessResponse(
    method: HealthProbeMethod,
    readiness: ReadinessState
): Response {
    return readiness.isReady()
        ? healthResponse(method, v.parse(readinessStatusSchema, { status: "ready" }), 200)
        : healthResponse(
              method,
              v.parse(readinessStatusSchema, { status: "not-ready" }),
              503
          );
}
