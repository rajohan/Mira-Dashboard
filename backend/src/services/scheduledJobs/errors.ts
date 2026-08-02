/** Signals an invalid scheduled-job definition or transition. */
export class ScheduledJobValidationError extends Error {
    declare statusCode: number;

    constructor(message: string) {
        super(message);
        this.name = "ScheduledJobValidationError";
        this.statusCode = 400;
    }
}

/** Returns whether an error is a scheduled-job validation failure. */
export function isScheduledJobValidationError(
    error: unknown
): error is ScheduledJobValidationError {
    return error instanceof ScheduledJobValidationError;
}
