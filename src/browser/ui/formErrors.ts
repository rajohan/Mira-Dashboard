/**
 * Extracts one presentable error from TanStack Form or Standard Schema metadata.
 * @param errors Unknown form-library error values.
 * @returns The first safe human-readable error, when present.
 */
export function firstFormFieldError(errors: readonly unknown[]): string | undefined {
    for (const error of errors) {
        if (typeof error === "string" && error.length > 0) return error;
        if (Array.isArray(error)) {
            const nested = firstFormFieldError(error);
            if (nested !== undefined) return nested;
        }
        if (
            typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string" &&
            error.message.length > 0
        ) {
            return error.message;
        }
    }
    return undefined;
}

/**
 * Hides whole-form validation findings until the corresponding field was edited.
 * @param metadata TanStack field interaction and error metadata.
 * @returns The first presentable error for a touched field.
 */
export function touchedFormFieldError(metadata: {
    readonly errors: readonly unknown[];
    readonly isTouched: boolean;
}): string | undefined {
    return metadata.isTouched ? firstFormFieldError(metadata.errors) : undefined;
}

/**
 * Applies one schema while the user edits and again at the authoritative submit gate.
 * Change validation starts only after the first edit, avoiding untouched-field noise.
 * @param schema TanStack Form-compatible Standard Schema validator.
 * @returns Shared progressive form-validation policy.
 */
export function progressiveFormValidators<TSchema>(schema: TSchema): {
    readonly onChange: TSchema;
    readonly onSubmit: TSchema;
} {
    return Object.freeze({ onChange: schema, onSubmit: schema });
}
