import type { DatabaseObservabilityCachePayload } from "./database.ts";

/** Worker-owned read-only collector used by the durable database cache action. */
export interface DatabaseObservabilityCollector {
    readonly collect: (
        signal?: AbortSignal
    ) => Promise<DatabaseObservabilityCachePayload>;
}
