import { expect } from "bun:test";

/**
 * Matches the required API error envelope while allowing route-specific details.
 * @param message Message to process.
 * @param code Status or verification code.
 * @returns Api error expectation result.
 */
export function apiErrorExpectation(
    message: unknown,
    code: unknown = expect.any(String)
): { error: unknown } {
    return {
        error: expect.objectContaining({
            code,
            message,
            requestId: expect.any(String),
        }),
    };
}
