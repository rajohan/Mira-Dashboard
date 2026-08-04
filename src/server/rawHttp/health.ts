import * as v from "valibot";

import { healthStatusSchema } from "../../contracts/system.ts";

function healthResponse(status: "live" | "ready"): Response {
    return Response.json(v.parse(healthStatusSchema, { status }));
}

/**
 * Handles the liveness protocol route.
 * @returns A validated liveness response.
 */
export function livenessResponse(): Response {
    return healthResponse("live");
}

/**
 * Handles the readiness protocol route.
 * @returns A validated readiness response.
 */
export function readinessResponse(): Response {
    return healthResponse("ready");
}
