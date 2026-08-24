import { bunRuntimePolicy } from "../../../shared/bunRuntimePolicy.ts";

/** Public runtime identity shape. */
export interface RuntimeIdentity {
    revision: string;
    version: string;
    versionWithRevision: string;
}

/** Runtime fields observed before the HTTP server is allowed to bind. */
export type ObservedRuntimeIdentity = Pick<RuntimeIdentity, "revision" | "version">;

const revisionPattern = /^[a-f\d]{40}$/u;

/**
 * Reads the serving runtime identity and enforces the Bun 1.4 API baseline.
 * @returns Public runtime identity for diagnostics.
 */
export function readRuntimeIdentity(
    observedRuntime?: ObservedRuntimeIdentity
): RuntimeIdentity {
    const runtime = observedRuntime ?? {
        revision: Bun.revision,
        version: Bun.version,
    };

    if (runtime.version !== bunRuntimePolicy.version) {
        throw new Error(`Serving Bun runtime must be ${bunRuntimePolicy.version}`);
    }
    if (!revisionPattern.test(runtime.revision)) {
        throw new Error("Serving Bun runtime revision is malformed");
    }

    return {
        revision: runtime.revision,
        version: runtime.version,
        versionWithRevision: `${runtime.version}+${runtime.revision.slice(0, 9)}`,
    };
}
