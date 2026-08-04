import * as v from "valibot";

const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const LOWERCASE_UUID_V7_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Builds a schema for a nonnegative JavaScript safe integer.
 * @param message Validation failure message.
 * @returns Valibot schema for a nonnegative safe integer.
 */
export function nonnegativeSafeIntegerSchema(
    message = "Expected a nonnegative safe integer."
) {
    return v.pipe(v.number(message), v.safeInteger(message), v.minValue(0, message));
}

/**
 * Builds a schema for a positive JavaScript safe integer.
 * @param message Validation failure message.
 * @returns Valibot schema for a positive safe integer.
 */
export function positiveSafeIntegerSchema(message = "Expected a positive safe integer.") {
    return v.pipe(v.number(message), v.safeInteger(message), v.minValue(1, message));
}

/**
 * Builds a schema for a canonical decimal string representing a nonnegative safe integer.
 * @param message Validation failure message.
 * @returns Valibot schema that transforms the canonical string to a number.
 */
export function nonnegativeDecimalSafeIntegerStringSchema(
    message = "Expected a canonical nonnegative safe-integer string."
) {
    return v.pipe(
        v.string(message),
        v.maxLength(16, message),
        v.regex(/^(?:0|[1-9]\d*)$/u, message),
        v.transform(Number),
        v.safeInteger(message),
        v.minValue(0, message)
    );
}

/**
 * Builds a schema for a lowercase hexadecimal SHA-256 digest.
 * @param message Validation failure message.
 * @returns Valibot schema for a lowercase SHA-256 digest.
 */
export function lowercaseSha256Schema(
    message = "Expected a lowercase SHA-256 checksum."
) {
    return v.pipe(v.string(message), lowercaseSha256Action(message));
}

/**
 * Builds a reusable lowercase SHA-256 refinement for an existing string schema.
 * @param message Validation failure message.
 * @returns Valibot lowercase SHA-256 regex action.
 */
export function lowercaseSha256Action(
    message = "Expected a lowercase SHA-256 checksum."
) {
    return v.regex(LOWERCASE_SHA256_PATTERN, message);
}

/**
 * Builds a schema for a full lowercase hexadecimal Git commit SHA.
 * @param message Validation failure message.
 * @returns Valibot schema for a full lowercase commit SHA.
 */
export function fullCommitShaSchema(message = "Expected a full lowercase commit SHA.") {
    return v.pipe(v.string(message), fullCommitShaAction(message));
}

/**
 * Builds a reusable full lowercase commit SHA refinement.
 * @param message Validation failure message.
 * @returns Valibot full commit SHA regex action.
 */
export function fullCommitShaAction(message = "Expected a full lowercase commit SHA.") {
    return v.regex(FULL_COMMIT_SHA_PATTERN, message);
}

/**
 * Builds a bounded schema for a canonical lowercase UUIDv7 identifier.
 * @param message Validation failure message.
 * @returns Valibot schema for a canonical lowercase UUIDv7.
 */
export function lowercaseUuidV7Schema(
    message = "Expected a lowercase UUIDv7 identifier."
) {
    return v.pipe(
        v.string(message),
        v.length(36, message),
        v.uuid(message),
        lowercaseUuidV7Action(message)
    );
}

/**
 * Builds a reusable lowercase UUIDv7 refinement for transport and storage schemas.
 * @param message Validation failure message.
 * @returns Valibot lowercase UUIDv7 regex action.
 */
export function lowercaseUuidV7Action(
    message = "Expected a lowercase UUIDv7 identifier."
) {
    return v.regex(LOWERCASE_UUID_V7_PATTERN, message);
}

/**
 * Parses a runtime boundary and preserves its public RangeError contract.
 * @param schema Valibot schema for the boundary.
 * @param input Untrusted configuration input.
 * @returns Validated schema output.
 */
export function parseSchemaWithRangeError<
    const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, input: unknown): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, input, { abortEarly: true });
    if (!result.success) {
        throw new RangeError(result.issues[0]?.message ?? "Configuration is invalid");
    }
    return result.output;
}
