import { AsyncLocalStorage } from "node:async_hooks";

import type { AuditActor } from "./services/auditEvents.ts";

export interface RequestAuditContext {
    actor: AuditActor;
    requestId: string;
}

const requestAuditStorage = new AsyncLocalStorage<RequestAuditContext>();

/** Runs request-owned work with provenance available to queued service calls. */
export function runWithRequestAuditContext<T>(
    context: RequestAuditContext,
    operation: () => T
): T {
    return requestAuditStorage.run(context, operation);
}

export function currentRequestAuditContext(): RequestAuditContext | undefined {
    return requestAuditStorage.getStore();
}
