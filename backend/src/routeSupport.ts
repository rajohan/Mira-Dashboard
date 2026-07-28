import type { ContractParser } from "../../contracts/runtime.ts";
import { apiErrorResponse, mapApiError } from "./apiErrors.ts";
import { readJson } from "./http.ts";

interface RouteErrorOptions {
    code?: string;
    context: string;
    message: string;
}

/** Reads JSON and validates it with a shared dependency-free contract parser. */
export async function readApiJson<T>(
    request: Request,
    parser: ContractParser<T>,
    options: { maxBytes?: number } = {}
): Promise<T> {
    return parser(await readJson<unknown>(request, options));
}

/** Maps one locally caught error through the same bounded API error contract. */
export function routeErrorResponse(
    request: Request,
    error: unknown,
    options: RouteErrorOptions
): Response {
    return apiErrorResponse(
        request,
        mapApiError(error, {
            ...(options.code && { code: options.code }),
            message: options.message,
        }),
        options.context
    );
}
