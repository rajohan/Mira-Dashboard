import { Effect } from "effect";

import type { JsonObject } from "../../../shared/json.ts";
import type { JobActionExecutionContext } from "./actionRegistry.ts";

/**
 * Persists observational job progress without replacing the authoritative job outcome.
 * @param context Active durable job context.
 * @param progress Bounded, public progress detail.
 */
export async function reportJobProgress(
    context: JobActionExecutionContext,
    progress: JsonObject
): Promise<void> {
    await Effect.runPromise(context.reportProgress(progress)).catch(() => {});
}
