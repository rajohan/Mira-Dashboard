import type { ContractParser } from "../../../../contracts/runtime.ts";
import { readApiJsonOrError, routeFailureResponse } from "../../http/routeSupport.ts";
import { stringFallback } from "../../lib/values.ts";

export function parameters(request: Request): Record<string, string | undefined> {
    return (request as Request & { params?: Record<string, string> }).params ?? {};
}

export function queryNumber(request: Request, key: string, fallback: number): number {
    const rawValue = new URL(request.url).searchParams.get(key);
    if (rawValue === null || rawValue === "") return fallback;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function dockerIdentifier(value: unknown): string | undefined {
    const identifier = stringFallback(value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(identifier)) return undefined;
    return identifier;
}

export function dockerImageIdentifier(value: unknown): string | undefined {
    const identifier = stringFallback(value).trim();
    if (/^sha256:[a-f0-9]{64}$/iu.test(identifier)) return identifier;
    return dockerIdentifier(identifier);
}

export function invalidDockerIdentifier(label: string): Response {
    return routeFailureResponse({
        context: "docker",
        message: `Invalid ${label}`,
        status: 400,
    });
}

export function parseJsonField<T>(value: string | undefined): T | undefined {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

export async function readDockerJson<T>(
    request: Request,
    parser: ContractParser<T>
): Promise<T | Response> {
    return readApiJsonOrError(request, parser, {
        code: "invalid_docker_request",
        context: "docker.body",
        message: "Invalid Docker request",
    });
}

export function parseServiceId(request: Request): number | undefined {
    const rawValue = parameters(request).serviceId;
    if (!rawValue || !/^\d+$/u.test(rawValue)) return undefined;
    const serviceId = Number(rawValue);
    return Number.isSafeInteger(serviceId) && serviceId > 0 ? serviceId : undefined;
}
