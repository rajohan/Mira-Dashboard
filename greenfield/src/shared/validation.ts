import * as v from "valibot";

const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const LOWERCASE_UUID_V7_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function decimalRangePattern(maximum: number): RegExp {
    const maximumDigits = String(maximum);
    const alternatives = ["0"];

    for (let length = 1; length < maximumDigits.length; length += 1) {
        alternatives.push(length === 1 ? "[1-9]" : `[1-9]\\d{${length - 1}}`);
    }
    for (let index = 0; index < maximumDigits.length; index += 1) {
        const maximumDigit = Number(maximumDigits[index]);
        const minimumDigit = index === 0 ? 1 : 0;
        if (maximumDigit <= minimumDigit) continue;

        const upperDigit = maximumDigit - 1;
        const digitRange =
            upperDigit === minimumDigit
                ? String(minimumDigit)
                : `[${minimumDigit}-${upperDigit}]`;
        const suffixLength = maximumDigits.length - index - 1;
        alternatives.push(
            `${maximumDigits.slice(0, index)}${digitRange}${
                suffixLength === 0 ? "" : `\\d{${suffixLength}}`
            }`
        );
    }
    alternatives.push(maximumDigits);
    return new RegExp(`^(?:${alternatives.join("|")})$`);
}

const CANONICAL_NONNEGATIVE_SAFE_INTEGER_PATTERN = decimalRangePattern(
    Number.MAX_SAFE_INTEGER
);
type StringRequirement = (value: string) => boolean;
const boundedNonBlankTextMaximumLengths = new WeakMap<StringRequirement, number>();

/**
 * Builds a bounded string schema that rejects blank values.
 * @param maximumLength Maximum accepted UTF-16 code-unit length.
 * @param message Validation failure message.
 * @returns Valibot schema for a bounded non-blank string.
 */
export function boundedNonBlankStringSchema(
    maximumLength: number,
    message = "Expected a bounded non-blank string."
) {
    return v.pipe(
        v.string(message),
        v.maxLength(maximumLength, message),
        v.regex(/\S/, message)
    );
}

/**
 * Refines a string boundary to reject embedded NUL characters.
 * @param message Validation failure message.
 * @returns Valibot action for a NUL-free string.
 */
export function noNulStringAction(message = "Expected a string without NUL characters.") {
    return v.check(hasNoNulCharacter, message);
}

/**
 * Tests the named persistence-safe NUL exclusion shared with JSON Schema generation.
 * @param value String value to inspect.
 * @returns Whether the string contains no embedded NUL character.
 */
export function hasNoNulCharacter(value: string): boolean {
    return !value.includes("\0");
}

function unicodeCodePointLength(value: string): number {
    let length = 0;
    for (const _codePoint of value) length += 1;
    return length;
}

/**
 * Builds a persistence-safe text schema using Unicode code-point length.
 * @param maximumLength Maximum accepted Unicode code-point length.
 * @param message Validation failure message.
 * @returns Valibot schema for bounded, nonblank, NUL-free text.
 */
export function boundedNonBlankTextSchema(
    maximumLength: number,
    message = "Expected bounded non-blank text."
) {
    const hasValidCodePointLength = (value: string): boolean => {
        const length = unicodeCodePointLength(value);
        return length > 0 && length <= maximumLength;
    };
    boundedNonBlankTextMaximumLengths.set(hasValidCodePointLength, maximumLength);
    return v.pipe(
        v.string(message),
        v.check(hasValidCodePointLength, message),
        v.regex(/\S/u, message),
        noNulStringAction(message)
    );
}

/**
 * Reads the Unicode code-point budget carried by a bounded-text requirement.
 * @param requirement Valibot check requirement to inspect.
 * @returns The registered maximum code-point length, when this module created it.
 */
export function getBoundedNonBlankTextMaximumLength(
    requirement: unknown
): number | undefined {
    return typeof requirement === "function"
        ? boundedNonBlankTextMaximumLengths.get(requirement as StringRequirement)
        : undefined;
}

/**
 * Tests the named scalar-array uniqueness rule shared by Valibot and JSON Schema generation.
 * Restricting this helper to JSON scalars keeps Set equality equivalent to `uniqueItems`.
 * @param values Scalar array values to compare by JSON-compatible equality.
 * @returns Whether every array value is unique.
 */
export function hasUniqueArrayItems<TItem extends boolean | null | number | string>(
    values: TItem[]
): boolean {
    return new Set(values).size === values.length;
}

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
        canonicalNonnegativeSafeIntegerStringSchema(message),
        v.transform(Number),
        v.safeInteger(message)
    );
}

/**
 * Builds a schema that preserves a canonical nonnegative safe-integer string.
 * @param message Validation failure message.
 * @returns Valibot schema for a canonical decimal cursor string.
 */
export function canonicalNonnegativeSafeIntegerStringSchema(
    message = "Expected a canonical nonnegative safe-integer string."
) {
    return v.pipe(
        v.string(message),
        v.maxLength(16, message),
        v.regex(CANONICAL_NONNEGATIVE_SAFE_INTEGER_PATTERN, message)
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
