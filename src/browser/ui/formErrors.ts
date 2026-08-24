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
