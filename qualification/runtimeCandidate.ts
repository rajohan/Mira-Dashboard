export { bunRuntimePolicy } from "../src/shared/bunRuntimePolicy.ts";

/** Runtime properties relevant to the qualification suite. */
export interface RuntimeIdentity {
    hasGlobalEventSource: boolean;
    revision: string;
    version: string;
}

/**
 * Reads identity and browser-API support from the executing Bun process.
 * @returns The runtime identity observed by the qualification process.
 */
export function readRuntimeIdentity(): RuntimeIdentity {
    return {
        hasGlobalEventSource: globalThis.EventSource !== undefined,
        revision: Bun.revision,
        version: Bun.version,
    };
}
