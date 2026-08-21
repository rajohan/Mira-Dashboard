import type { ApplicationConfigurationEnvironmentName } from "../../../shared/configuration/applicationConfigurationRegistry.ts";

export type ApplicationConfigurationFailureReason =
    | "inconsistent"
    | "invalid"
    | "missing";

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

/** Redacted composition failure that never retains the rejected input or parser cause. */
export class ApplicationConfigurationError extends Error {
    readonly _tag = "ApplicationConfigurationError";
    readonly field: ApplicationConfigurationEnvironmentName;
    readonly reason: ApplicationConfigurationFailureReason;

    constructor(
        field: ApplicationConfigurationEnvironmentName,
        reason: ApplicationConfigurationFailureReason
    ) {
        super(`Application configuration ${field} is ${reason}`);
        this.name = "ApplicationConfigurationError";
        this.field = field;
        this.reason = reason;
    }

    /**
     * Produces a stable diagnostic payload containing no rejected value or cause.
     * @returns Frozen redacted diagnostic fields.
     */
    toJSON(): Readonly<{
        _tag: "ApplicationConfigurationError";
        field: ApplicationConfigurationEnvironmentName;
        reason: ApplicationConfigurationFailureReason;
    }> {
        return Object.freeze({
            _tag: this._tag,
            field: this.field,
            reason: this.reason,
        });
    }

    /**
     * Keeps Node/Bun inspection on the same redacted surface as JSON serialization.
     * @returns Frozen redacted diagnostic fields.
     */
    [inspectSymbol](): ReturnType<ApplicationConfigurationError["toJSON"]> {
        return this.toJSON();
    }
}
