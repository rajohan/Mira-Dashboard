import type { ContractParser } from "../../../contracts/runtime.ts";
import { apiErrorCodeForStatus, apiErrorResponse, mapApiError } from "./apiErrors.ts";
import { readJson } from "./core.ts";

interface RouteErrorOptions {
    code?: string;
    context: string;
    message: string;
}

interface RouteFailureOptions extends RouteErrorOptions {
    details?: unknown;
    retryAfterSeconds?: number;
    status: number;
}

interface ReadApiJsonOrErrorOptions extends RouteErrorOptions {
    maxBytes?: number;
}

export type ParametersRequest<T extends string> = Request & {
    params: Record<T, string>;
};

/**
 * Reads JSON and validates it with a shared runtime contract parser.
 * @returns Read JSON and validates it with a shared runtime contract parser.
 */
export async function readApiJson<T>(
    request: Request,
    parser: ContractParser<T>,
    options: { maxBytes?: number } = {}
): Promise<T> {
    return parser(await readJson<unknown>(request, options));
}

/**
 * Reads and validates JSON while mapping malformed input to the shared API
 * error envelope.
 * @param request Request to process.
 * @param parser Runtime value parser.
 * @param options Body limit and public error metadata.
 * @returns Parsed input or a structured error response.
 */
export async function readApiJsonOrError<T>(
    request: Request,
    parser: ContractParser<T>,
    options: ReadApiJsonOrErrorOptions
): Promise<Response | T> {
    try {
        return await readApiJson(request, parser, {
            ...(options.maxBytes !== undefined && { maxBytes: options.maxBytes }),
        });
    } catch (error) {
        return routeErrorResponse(request, error, options);
    }
}

/**
 * Maps one locally caught error through the same bounded API error contract.
 * @param request Request to process.
 * @param error Error to inspect.
 * @param options Operation options.
 * @returns Mapped one locally caught error through the same bounded API error contract.
 */
export function routeErrorResponse(
    request: Request | undefined,
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

/**
 * Emits a known route failure through the shared strict API error contract.
 * @returns Route failure response result.
 */
export function routeFailureResponse(
    options: RouteFailureOptions,
    request?: Request
): Response {
    return apiErrorResponse(
        request,
        {
            code: options.code ?? apiErrorCodeForStatus(options.status),
            ...(options.details !== undefined && { details: options.details }),
            message: options.message,
            ...(options.retryAfterSeconds !== undefined && {
                retryAfterSeconds: options.retryAfterSeconds,
            }),
            status: options.status,
        },
        options.context
    );
}
