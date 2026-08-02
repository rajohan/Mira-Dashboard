import type { ContractParser } from "../../../../contracts/runtime.ts";
import { readApiJsonOrError } from "../../http/routeSupport.ts";

/**
 * Reads and validates a bounded authentication request body.
 * @param request HTTP request.
 * @param parser Contract parser.
 * @returns Parsed body or a stable error response.
 */
export async function readAuthBody<T>(
    request: Request,
    parser: ContractParser<T>
): Promise<Response | T> {
    return readApiJsonOrError(request, parser, {
        code: "invalid_auth_request",
        context: "auth.body",
        maxBytes: 128 * 1024,
        message: "Invalid request body",
    });
}
