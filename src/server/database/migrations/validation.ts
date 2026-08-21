import * as v from "valibot";

const migrationIdPattern = /^\d{14}_[a-z\d][a-z\d_-]*$/u;
export const migrationIdMaximumLength = 128;

/**
 * Builds the canonical tracked migration-folder identifier schema.
 * @param message Validation failure message.
 * @returns Valibot schema for a canonical migration identifier.
 */
export function migrationIdSchema(message: string) {
    return v.pipe(
        v.string(message),
        v.maxLength(migrationIdMaximumLength, message),
        v.regex(migrationIdPattern, message)
    );
}

/**
 * Builds a migration-id refinement for an existing generated string schema.
 * @param message Validation failure message.
 * @returns Valibot migration identifier regex action.
 */
export function migrationIdAction(message: string) {
    return v.regex(migrationIdPattern, message);
}
