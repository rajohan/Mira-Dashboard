export interface HttpStatusError extends Error {
    statusCode?: number;
}

/** Returns a stable message for unknown caught values. */
export function errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) {
        return fallback;
    }
    return error.message.trim() || fallback;
}

export function httpStatusCode(error: unknown): number {
    if (typeof error === "object" && error !== undefined) {
        const statusCode = (error as HttpStatusError).statusCode;
        if (
            typeof statusCode === "number" &&
            Number.isSafeInteger(statusCode) &&
            statusCode >= 400 &&
            statusCode <= 599
        ) {
            return statusCode;
        }
    }
    return 500;
}
