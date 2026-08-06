import * as v from "valibot";

import { bunRuntimePolicy } from "../../../shared/bunRuntimePolicy.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";

/** Public runtime identity shape. */
export interface RuntimeIdentity {
    revision: string;
    version: string;
    versionWithRevision: string;
}

/** Runtime fields observed before the HTTP server is allowed to bind. */
export type ObservedRuntimeIdentity = Pick<RuntimeIdentity, "revision" | "version">;

const runtimeVersionError = `Serving Bun runtime must be ${bunRuntimePolicy.version}`;
const runtimeRevisionError = "Serving Bun runtime revision is malformed";
const observedRuntimeIdentitySchema = v.strictObject(
    {
        version: v.literal(bunRuntimePolicy.version, runtimeVersionError),
        revision: fullCommitShaSchema(runtimeRevisionError),
    },
    runtimeVersionError
);

/**
 * Reads the serving runtime identity and enforces the Bun 1.4 API baseline.
 * @returns Public runtime identity for diagnostics.
 */
export function readRuntimeIdentity(
    observedRuntime?: ObservedRuntimeIdentity
): RuntimeIdentity {
    const unverifiedRuntime: unknown = observedRuntime ?? {
        revision: Bun.revision,
        version: Bun.version,
    };
    const validation = v.safeParse(observedRuntimeIdentitySchema, unverifiedRuntime, {
        abortEarly: true,
    });
    if (!validation.success) {
        throw new Error(validation.issues[0]?.message ?? runtimeVersionError);
    }
    const runtime = validation.output;

    return {
        revision: runtime.revision,
        version: runtime.version,
        versionWithRevision: `${runtime.version}+${runtime.revision.slice(0, 9)}`,
    };
}
