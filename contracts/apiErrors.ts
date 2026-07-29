import * as v from "valibot";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const apiErrorBodySchema = v.strictObject({
    code: trimmedNonEmptyStringSchema,
    details: v.optional(v.unknown()),
    message: trimmedNonEmptyStringSchema,
    requestId: trimmedNonEmptyStringSchema,
});

export const apiErrorResponseSchema = v.strictObject({
    error: apiErrorBodySchema,
});

export type ApiErrorBody = v.InferOutput<typeof apiErrorBodySchema>;
export type ApiErrorResponse = v.InferOutput<typeof apiErrorResponseSchema>;

/**
 * Parses the shared error contract at the HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed the shared error contract at the HTTP trust boundary.
 */
export function parseApiErrorResponse(value: unknown): ApiErrorBody | undefined {
    const result = v.safeParse(apiErrorResponseSchema, value);
    return result.success ? result.output.error : undefined;
}
