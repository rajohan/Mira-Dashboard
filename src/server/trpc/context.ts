/** Dependencies supplied to every greenfield tRPC procedure. */
export interface RequestContext {
    requestId: string;
}

/**
 * Builds request-scoped tRPC context without reading mutable global state.
 * @returns Fresh request context.
 */
export function createRequestContext(): RequestContext {
    return { requestId: crypto.randomUUID() };
}
