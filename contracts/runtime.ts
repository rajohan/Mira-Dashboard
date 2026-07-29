import * as v from "valibot";

export interface ContractValidationIssue {
    message: string;
    path: string;
}

/** Represents a runtime contract failure at a trust boundary. */
export class ContractValidationError extends Error {
    readonly issues: ContractValidationIssue[];

    constructor(issues: ContractValidationIssue[]) {
        super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
        this.name = "ContractValidationError";
        this.issues = issues;
    }
}

export type ContractParser<T> = (value: unknown) => T;

export const finiteNumberSchema = v.pipe(v.number(), v.finite());
export const nonNegativeIntegerSchema = v.pipe(
    finiteNumberSchema,
    v.safeInteger(),
    v.minValue(0)
);
export const positiveIntegerSchema = v.pipe(
    finiteNumberSchema,
    v.safeInteger(),
    v.minValue(1)
);
export const jsonObjectSchema = v.pipe(
    v.unknown(),
    v.check(isPlainRecord, "must be an object"),
    v.record(v.string(), v.unknown())
);
export const successLiteralSchema = v.literal(true);

/**
 * Determines whether an unknown value is a plain JSON-style record.
 *
 * @param value - Candidate record.
 * @returns Whether the value has an object or null prototype and is not an array.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Builds a strict object schema that rejects arrays before Valibot projects
 * object entries.
 *
 * @param entries - Typed object entries.
 * @returns A plain JSON-object schema with no unknown keys.
 */
export function strictJsonObjectSchema<const TEntries extends v.ObjectEntries>(
    entries: TEntries
) {
    return v.pipe(
        v.unknown(),
        v.check(isPlainRecord, "must be an object"),
        v.strictObject(entries)
    );
}

/**
 * Builds a loose object schema that rejects arrays before retaining provider
 * extension fields.
 *
 * @param entries - Typed object entries.
 * @returns A plain JSON-object schema that preserves unknown keys.
 */
export function looseJsonObjectSchema<const TEntries extends v.ObjectEntries>(
    entries: TEntries
) {
    return v.pipe(
        v.unknown(),
        v.check(isPlainRecord, "must be an object"),
        v.looseObject(entries)
    );
}

function qualifiedContractPath(root: string, issue: v.BaseIssue<unknown>): string {
    const issuePath = v.getDotPath(issue);
    const normalizedPath = issuePath?.replaceAll(/\.(\d+)(?=\.|$)/gu, "[$1]");
    return normalizedPath ? `${root}.${normalizedPath}` : root;
}

/**
 * Parses a Valibot schema and maps its issues to the shared API contract error.
 * @returns Parsed a Valibot schema and maps its issues to the shared API contract error.
 */
export function parseContract<
    const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: unknown, path = "body"): v.InferOutput<TSchema> {
    try {
        return v.parse(schema, value);
    } catch (error) {
        if (!v.isValiError(error)) {
            throw error;
        }
        throw new ContractValidationError(
            error.issues.map((issue) => ({
                message: issue.message,
                path: qualifiedContractPath(path, issue),
            }))
        );
    }
}
