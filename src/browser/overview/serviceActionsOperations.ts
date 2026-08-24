import type { QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    RequestServiceActionInput,
    ServiceActionId,
} from "../../contracts/serviceActions.ts";
import { authStatusCacheIdentity, authStatusQueryKey } from "../auth/authQueries.ts";

export const serviceActionRecoveryStoragePrefix =
    "mira-dashboard.service-actions.request.v1:";

const serviceActionIdempotencyKeyPattern = /^[0-9a-f]{32}$/u;

export interface ServiceActionPresentation {
    readonly actionLabel: string;
    readonly buttonLabel: string;
    readonly confirmationLabel: string;
    readonly confirmationTitle: string;
    readonly retryLabel: string;
    readonly warning: string;
}

export const serviceActionPresentations = Object.freeze({
    "dashboard-restart": {
        actionLabel: "Dashboard restart",
        buttonLabel: "Restart Dashboard",
        confirmationLabel: "Restart Dashboard",
        confirmationTitle: "Restart the Dashboard?",
        retryLabel: "Retry Dashboard restart request",
        warning:
            "The browser will disconnect briefly while the Dashboard web process restarts. The worker and queued jobs continue running.",
    },
    "dashboard-stack-restart": {
        actionLabel: "Dashboard + worker restart",
        buttonLabel: "Restart both",
        confirmationLabel: "Restart both",
        confirmationTitle: "Restart the Dashboard and worker?",
        retryLabel: "Retry combined restart request",
        warning:
            "The Dashboard web process and worker will both restart. Active worker jobs are interrupted and recovered according to their durable job policy.",
    },
    "openclaw-cleanup": {
        actionLabel: "OpenClaw cleanup",
        buttonLabel: "Queue OpenClaw cleanup",
        confirmationLabel: "Queue cleanup",
        confirmationTitle: "Queue OpenClaw cleanup?",
        retryLabel: "Retry OpenClaw cleanup request",
        warning:
            "This queues OpenClaw's own bounded session and artifact maintenance. Review Dashboard jobs for the durable result.",
    },
    "openclaw-restart": {
        actionLabel: "OpenClaw restart",
        buttonLabel: "Queue OpenClaw restart",
        confirmationLabel: "Queue restart",
        confirmationTitle: "Queue an OpenClaw restart?",
        retryLabel: "Retry OpenClaw restart request",
        warning:
            "Restarting the OpenClaw Gateway interrupts active Gateway sessions. Review Dashboard jobs for the durable result. A queued request does not confirm that the restart completed.",
    },
    "openclaw-update": {
        actionLabel: "OpenClaw update",
        buttonLabel: "Queue OpenClaw update",
        confirmationLabel: "Queue update",
        confirmationTitle: "Queue OpenClaw update?",
        retryLabel: "Retry OpenClaw update request",
        warning:
            "OpenClaw updates can take time and may restart the Gateway. The Dashboard only confirms that the durable request was queued.",
    },
    "system-cleanup": {
        actionLabel: "System cleanup",
        buttonLabel: "Queue system cleanup",
        confirmationLabel: "Queue cleanup",
        confirmationTitle: "Queue a system cleanup?",
        retryLabel: "Retry system cleanup request",
        warning:
            "System cleanup removes only fixed categories: orphan packages and caches, bounded journal history, and unused Docker content older than seven days. Docker volumes are never deleted. Review Dashboard jobs for the durable result.",
    },
    "system-restart": {
        actionLabel: "System restart",
        buttonLabel: "Queue system restart",
        confirmationLabel: "Queue restart",
        confirmationTitle: "Queue a system restart?",
        retryLabel: "Retry system restart request",
        warning:
            "A system restart request interrupts Dashboard, OpenClaw, and other host services. Success here means the restart request was accepted for durable processing, not that the host restarted.",
    },
    "system-update": {
        actionLabel: "System update",
        buttonLabel: "Queue system update",
        confirmationLabel: "Queue update",
        confirmationTitle: "Queue a system update?",
        retryLabel: "Retry system update request",
        warning:
            "System updates can take a long time and may affect running services. Review Dashboard jobs for the durable result.",
    },
    "worker-restart": {
        actionLabel: "Worker restart",
        buttonLabel: "Restart worker",
        confirmationLabel: "Restart worker",
        confirmationTitle: "Restart the Dashboard worker?",
        retryLabel: "Retry worker restart request",
        warning:
            "Active worker jobs are interrupted and recovered according to their durable job policy. The queued request confirms only that the fixed restart handoff was accepted.",
    },
} satisfies Readonly<Record<ServiceActionId, ServiceActionPresentation>>);

export class ServiceActionRecoveryError extends Error {
    constructor() {
        super("Service action recovery is unavailable");
        this.name = "ServiceActionRecoveryError";
    }
}

/** @returns The exact authenticated user/session browser identity, when available. */
export function authenticatedServiceActionIdentity(
    queryClient: QueryClient
): string | undefined {
    const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
    return status?.state === "authenticated"
        ? authStatusCacheIdentity(status)
        : undefined;
}

function serviceActionRecoveryStorageKey(
    identity: string,
    actionId: ServiceActionId
): string {
    return `${serviceActionRecoveryStoragePrefix}${identity}:${actionId}`;
}

/**
 * @param identity Exact authenticated browser identity, when available.
 * @param actionId Fixed action whose recovery state is inspected.
 * @returns Whether the exact identity and action retain a recovery key.
 */
export function serviceActionRecoveryExists(
    identity: string | undefined,
    actionId: ServiceActionId
): boolean {
    if (identity === undefined) return false;
    try {
        return (
            globalThis.sessionStorage.getItem(
                serviceActionRecoveryStorageKey(identity, actionId)
            ) !== null
        );
    } catch {
        return false;
    }
}

/**
 * Returns an existing identity/action-bound key or durably records a fresh key.
 * Storage failure is fail-closed so a privileged request is never sent unrecoverably.
 * @param identity Exact authenticated browser identity.
 * @param actionId Fixed action whose request identity is retained.
 * @returns The retained or newly persisted idempotency key.
 */
export function readOrCreateServiceActionIdempotencyKey(
    identity: string,
    actionId: ServiceActionId
): string {
    const storageKey = serviceActionRecoveryStorageKey(identity, actionId);
    let current: string | null;
    try {
        current = globalThis.sessionStorage.getItem(storageKey);
    } catch {
        throw new ServiceActionRecoveryError();
    }
    if (current !== null) {
        if (serviceActionIdempotencyKeyPattern.test(current)) return current;
        throw new ServiceActionRecoveryError();
    }

    const created = globalThis.crypto.randomUUID().replaceAll("-", "");
    try {
        globalThis.sessionStorage.setItem(storageKey, created);
        if (globalThis.sessionStorage.getItem(storageKey) !== created) {
            throw new ServiceActionRecoveryError();
        }
    } catch {
        throw new ServiceActionRecoveryError();
    }
    return created;
}

/**
 * @param identity Exact authenticated browser identity.
 * @param actionId Fixed action whose confirmed recovery key is removed.
 * @returns Whether the exact recovery key was observably removed.
 */
export function clearServiceActionRecovery(
    identity: string,
    actionId: ServiceActionId
): boolean {
    const storageKey = serviceActionRecoveryStorageKey(identity, actionId);
    try {
        globalThis.sessionStorage.removeItem(storageKey);
        return globalThis.sessionStorage.getItem(storageKey) === null;
    } catch {
        return false;
    }
}

/**
 * @param actionId Fixed action selected by the operator.
 * @param idempotencyKey Browser-retained request identity.
 * @returns The exact contract input for one fixed action.
 */
export function serviceActionRequestInput(
    actionId: ServiceActionId,
    idempotencyKey: string
): RequestServiceActionInput {
    switch (actionId) {
        case "dashboard-restart": {
            return {
                actionId,
                confirmation: "restart-dashboard",
                idempotencyKey,
            };
        }
        case "dashboard-stack-restart": {
            return {
                actionId,
                confirmation: "restart-dashboard-stack",
                idempotencyKey,
            };
        }
        case "openclaw-cleanup": {
            return {
                actionId,
                confirmation: "cleanup-openclaw",
                idempotencyKey,
            };
        }
        case "openclaw-restart": {
            return {
                actionId,
                confirmation: "restart-openclaw",
                idempotencyKey,
            };
        }
        case "openclaw-update": {
            return {
                actionId,
                confirmation: "update-openclaw",
                idempotencyKey,
            };
        }
        case "system-cleanup": {
            return {
                actionId,
                confirmation: "cleanup-system",
                idempotencyKey,
            };
        }
        case "system-restart": {
            return {
                actionId,
                confirmation: "restart-system",
                idempotencyKey,
            };
        }
        case "system-update": {
            return {
                actionId,
                confirmation: "update-system",
                idempotencyKey,
            };
        }
        case "worker-restart": {
            return {
                actionId,
                confirmation: "restart-worker",
                idempotencyKey,
            };
        }
    }
}
