import { getTime, isValid } from "date-fns";
import * as v from "valibot";

import { nonnegativeSafeIntegerSchema } from "./validation.ts";

/**
 * Builds a schema for an epoch-millisecond value representable by JavaScript Date.
 * @param message Validation failure message.
 * @returns Valibot schema for a valid Date timestamp in milliseconds.
 */
export function timestampMillisecondsSchema(
    message = "Expected valid Date milliseconds."
) {
    return v.pipe(
        nonnegativeSafeIntegerSchema(message),
        v.check((value: number) => isValid(value), message)
    );
}

/**
 * Builds a date-fns-backed refinement for a nonnegative epoch Date.
 * @param message Validation failure message.
 * @returns Valibot refinement for a valid Date on or after the Unix epoch.
 */
export function nonnegativeDateAction(
    message = "Expected a valid nonnegative epoch Date."
) {
    return v.check((value: Date) => isValid(value) && getTime(value) >= 0, message);
}
