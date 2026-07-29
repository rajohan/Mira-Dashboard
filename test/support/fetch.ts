/**
 * Returns the URL represented by a Fetch API request input.
 *
 * @param input - Fetch request input supplied to a test double.
 * @returns The request URL as a string.
 */
export function requestUrl(input: Request | string | URL): string {
    if (typeof input === "string") {
        return input;
    }
    return input instanceof URL ? input.href : input.url;
}

/**
 * Returns a string request body or fails when a test supplied another body type.
 *
 * @param body - Request body supplied to a test double.
 * @param fallback - Value returned when the request has no body.
 * @returns The request body text or the supplied fallback.
 */
export function requestBodyText(
    body: RequestInit["body"] | undefined,
    fallback = ""
): string {
    if (body === undefined || body === null) {
        return fallback;
    }
    if (typeof body !== "string") {
        throw new TypeError("Expected the test request body to be a string");
    }
    return body;
}

/**
 * Parses JSON test data without allowing the platform's `any` return type to escape.
 *
 * @param text - Serialized JSON test data.
 * @returns The untrusted parsed value.
 */
export function parseJsonText(text: string): unknown {
    return JSON.parse(text) as unknown;
}

/**
 * Reads a response body without allowing Fetch's `any` JSON type to escape.
 *
 * @param response - Fetch response returned by the code under test.
 * @returns The untrusted parsed response value.
 */
export async function readResponseJson(response: Response): Promise<unknown> {
    return (await response.json()) as unknown;
}
