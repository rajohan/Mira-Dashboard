import { runtimeManifest } from "../../../shared/runtimeManifest.ts";

/** Public runtime identity shape. */
export interface RuntimeIdentity {
    revision: string;
    version: string;
    versionWithRevision: string;
}

/**
 * Reads and verifies the Bun runtime identity used by the serving process.
 * @returns Exact public runtime identity.
 */
export function readRuntimeIdentity(): RuntimeIdentity {
    if (
        Bun.revision !== runtimeManifest.revision ||
        Bun.version !== runtimeManifest.version
    ) {
        throw new Error(
            "Serving Bun runtime does not match the qualified runtime manifest"
        );
    }

    return {
        revision: Bun.revision,
        version: Bun.version,
        versionWithRevision: runtimeManifest.versionWithRevision,
    };
}
