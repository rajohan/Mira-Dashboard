import * as v from "valibot";

import {
    type ListOpenClawSkillsResult,
    type OpenClawConfigurationSnapshot,
    type SetOpenClawSkillEnabledInput,
    type SetOpenClawSkillEnabledResult,
    type UpdateOpenClawConfigurationInput,
    type UpdateOpenClawConfigurationResult,
    listOpenClawSkillsResultSchema,
    openClawConfigurationSnapshotSchema,
    setOpenClawSkillEnabledInputSchema,
    setOpenClawSkillEnabledResultSchema,
    updateOpenClawConfigurationInputSchema,
    updateOpenClawConfigurationResultSchema,
} from "../../../contracts/openClawSettings.ts";
import {
    type OpenClawSettingsAuditContext,
    type OpenClawSettingsAuditOperation,
    type OpenClawSettingsAuditSettlementFailure,
    type OpenClawSettingsOperationAuditWriter,
    openClawSettingsAuditTargetFingerprint,
} from "./operationAudit.ts";
import {
    OpenClawSettingsProviderError,
    type OpenClawSettingsProvider,
} from "./provider.ts";

export type OpenClawSettingsServiceErrorReason =
    | "audit-unavailable"
    | "conflict"
    | "not-found"
    | "provider-data-invalid"
    | "provider-unavailable"
    | "unknown-outcome";

/** Maximum active plus queued privileged Settings mutations retained in web memory. */
export const openClawSettingsMutationMaximumPending = 16;

/** Sanitized domain failure; provider errors and configuration values never cross tRPC. */
export class OpenClawSettingsServiceError extends Error {
    readonly reason: OpenClawSettingsServiceErrorReason;

    constructor(reason: OpenClawSettingsServiceErrorReason, options?: ErrorOptions) {
        super("OpenClaw settings operation failed", options);
        this.name = "OpenClawSettingsServiceError";
        this.reason = reason;
    }
}

export interface OpenClawSettingsControlContext extends OpenClawSettingsAuditContext {
    /** Re-checks current session/MFA state at the provider's dispatch boundary. */
    readonly reauthorize: () => void;
}

export interface OpenClawSettingsService {
    readonly getConfiguration: (
        signal?: AbortSignal
    ) => Promise<OpenClawConfigurationSnapshot>;
    readonly listSkills: (signal?: AbortSignal) => Promise<ListOpenClawSkillsResult>;
    readonly setSkillEnabled: (
        input: SetOpenClawSkillEnabledInput,
        context: OpenClawSettingsControlContext,
        signal?: AbortSignal
    ) => Promise<SetOpenClawSkillEnabledResult>;
    readonly updateConfiguration: (
        input: UpdateOpenClawConfigurationInput,
        context: OpenClawSettingsControlContext,
        signal?: AbortSignal
    ) => Promise<UpdateOpenClawConfigurationResult>;
}

export interface OpenClawSettingsServiceOptions {
    /** Test-only opt-out; production controls fail closed without durable audit. */
    readonly auditRequired?: boolean;
    readonly auditWriter?: OpenClawSettingsOperationAuditWriter;
    readonly onAuditSettlementFailure?: (
        failure: OpenClawSettingsAuditSettlementFailure
    ) => void;
    readonly mutationClockMs?: () => number;
    readonly onMutationQueueWait?: (observation: {
        readonly queueDepth: number;
        readonly waitMs: number;
    }) => void;
    readonly provider: OpenClawSettingsProvider;
}

function serviceError(error: unknown): OpenClawSettingsServiceError {
    if (error instanceof OpenClawSettingsServiceError) return error;
    if (!(error instanceof OpenClawSettingsProviderError)) {
        return new OpenClawSettingsServiceError("provider-unavailable", {
            cause: error,
        });
    }
    switch (error.reason) {
        case "conflict":
        case "not-found":
        case "unknown-outcome": {
            return new OpenClawSettingsServiceError(error.reason, { cause: error });
        }
        case "data-invalid": {
            return new OpenClawSettingsServiceError("provider-data-invalid", {
                cause: error,
            });
        }
        case "unavailable": {
            return new OpenClawSettingsServiceError("provider-unavailable", {
                cause: error,
            });
        }
    }
}

function signalOptions(signal?: AbortSignal): Readonly<{ signal?: AbortSignal }> {
    return signal === undefined ? {} : { signal };
}

function signalAbortError(signal: AbortSignal): Error {
    try {
        signal.throwIfAborted();
    } catch (error) {
        if (error instanceof Error) return error;
    }
    return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Creates bounded Settings reads and serialized, audited recent-MFA controls.
 * @returns The OpenClaw Settings service.
 */
export function createOpenClawSettingsService(
    options: OpenClawSettingsServiceOptions
): OpenClawSettingsService {
    const auditRequired = options.auditRequired ?? true;
    const mutationClockMs =
        options.mutationClockMs ?? (() => Math.trunc(performance.now()));
    interface MutationWaiter {
        readonly reject: (reason: unknown) => void;
        readonly resolve: () => void;
        readonly signal?: AbortSignal;
        onAbort?: () => void;
    }
    const mutationWaiters: MutationWaiter[] = [];
    let mutationActive = false;
    let pendingMutationCount = 0;

    function readMutationClock(): number {
        const value = mutationClockMs();
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError("OpenClaw settings mutation clock is invalid");
        }
        return value;
    }

    function observeMutationQueue(queueDepth: number, waitMs: number): void {
        if (queueDepth === 0) return;
        try {
            options.onMutationQueueWait?.({ queueDepth, waitMs });
        } catch {
            // Operational observation cannot replace a control result.
        }
    }

    async function acquireMutation(signal: AbortSignal | undefined): Promise<void> {
        if (!mutationActive) {
            mutationActive = true;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: MutationWaiter = {
                reject,
                resolve,
                ...(signal ? { signal } : {}),
            };
            const onAbort = (): void => {
                const index = mutationWaiters.indexOf(waiter);
                if (index === -1) return;
                mutationWaiters.splice(index, 1);
                signal?.removeEventListener("abort", onAbort);
                reject(
                    signal === undefined
                        ? new DOMException("The operation was aborted", "AbortError")
                        : signalAbortError(signal)
                );
            };
            waiter.onAbort = onAbort;
            mutationWaiters.push(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
    }

    function releaseMutation(): void {
        const waiter = mutationWaiters.shift();
        if (waiter === undefined) {
            mutationActive = false;
            return;
        }
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve();
    }

    async function recordAttempt(
        operation: OpenClawSettingsAuditOperation,
        targetId: string,
        context: OpenClawSettingsAuditContext
    ): Promise<void> {
        if (options.auditWriter === undefined) {
            if (!auditRequired) return;
            throw new OpenClawSettingsServiceError("audit-unavailable");
        }
        try {
            await options.auditWriter.record({
                ...context,
                operation,
                settlement: "attempted",
                targetId,
            });
        } catch (error) {
            throw new OpenClawSettingsServiceError("audit-unavailable", {
                cause: error,
            });
        }
    }

    async function settleAudit(
        operation: OpenClawSettingsAuditOperation,
        settlement: "failed" | "partial" | "succeeded",
        targetId: string,
        context: OpenClawSettingsAuditContext
    ): Promise<void> {
        try {
            await options.auditWriter?.record({
                ...context,
                operation,
                settlement,
                targetId,
            });
        } catch (error) {
            try {
                options.onAuditSettlementFailure?.({
                    cause: error,
                    operation,
                    settlement,
                    targetFingerprint: openClawSettingsAuditTargetFingerprint(targetId),
                });
            } catch {
                // Operational reporting cannot replace an already-known provider result.
            }
        }
    }

    async function withMutationLock<T>(
        signal: AbortSignal | undefined,
        operation: () => Promise<T>
    ): Promise<T> {
        signal?.throwIfAborted();
        if (pendingMutationCount >= openClawSettingsMutationMaximumPending) {
            throw new OpenClawSettingsServiceError("provider-unavailable");
        }
        const queuedAtMs = readMutationClock();
        const queueDepth = pendingMutationCount;
        pendingMutationCount += 1;
        let acquired = false;
        try {
            await acquireMutation(signal);
            acquired = true;
            observeMutationQueue(
                queueDepth,
                Math.max(0, readMutationClock() - queuedAtMs)
            );
            signal?.throwIfAborted();
            return await operation();
        } finally {
            pendingMutationCount -= 1;
            if (acquired) releaseMutation();
        }
    }

    async function withControlAudit<T>(
        operation: OpenClawSettingsAuditOperation,
        targetId: string,
        context: OpenClawSettingsControlContext,
        signal: AbortSignal | undefined,
        execute: () => Promise<T>
    ): Promise<T> {
        await recordAttempt(operation, targetId, context);
        try {
            signal?.throwIfAborted();
            const result = await execute();
            await settleAudit(operation, "succeeded", targetId, context);
            return result;
        } catch (error) {
            const mapped =
                error instanceof OpenClawSettingsProviderError ||
                error instanceof OpenClawSettingsServiceError
                    ? serviceError(error)
                    : error;
            await settleAudit(
                operation,
                mapped instanceof OpenClawSettingsServiceError &&
                    mapped.reason === "unknown-outcome"
                    ? "partial"
                    : "failed",
                targetId,
                context
            );
            throw mapped;
        }
    }

    async function executeAuthorizedMutation<T>(
        context: OpenClawSettingsControlContext,
        signal: AbortSignal | undefined,
        execute: (authorizeDispatch: () => Promise<void>) => Promise<unknown>,
        parseResult: (result: unknown) => T
    ): Promise<T> {
        let authorizationFailed = false;
        let authorizationFailure: unknown;
        try {
            const result = await execute(async () => {
                await Promise.resolve();
                try {
                    signal?.throwIfAborted();
                    context.reauthorize();
                    signal?.throwIfAborted();
                } catch (error) {
                    authorizationFailed = true;
                    authorizationFailure = error;
                    throw error;
                }
            });
            if (authorizationFailed) throw authorizationFailure;
            return parseResult(result);
        } catch (error) {
            if (authorizationFailed && error === authorizationFailure) throw error;
            if (signal?.aborted) throw error;
            if (error instanceof v.ValiError) {
                throw new OpenClawSettingsServiceError("unknown-outcome", {
                    cause: error,
                });
            }
            throw serviceError(error);
        }
    }

    async function getConfiguration(
        signal?: AbortSignal
    ): Promise<OpenClawConfigurationSnapshot> {
        signal?.throwIfAborted();
        try {
            const result = await options.provider.getConfiguration(signalOptions(signal));
            signal?.throwIfAborted();
            return v.parse(openClawConfigurationSnapshotSchema, result);
        } catch (error) {
            if (signal?.aborted) throw error;
            if (error instanceof v.ValiError) {
                throw new OpenClawSettingsServiceError("provider-data-invalid", {
                    cause: error,
                });
            }
            throw serviceError(error);
        }
    }

    async function listSkills(signal?: AbortSignal): Promise<ListOpenClawSkillsResult> {
        signal?.throwIfAborted();
        try {
            const result = await options.provider.listSkills(signalOptions(signal));
            signal?.throwIfAborted();
            return v.parse(listOpenClawSkillsResultSchema, result);
        } catch (error) {
            if (signal?.aborted) throw error;
            if (error instanceof v.ValiError) {
                throw new OpenClawSettingsServiceError("provider-data-invalid", {
                    cause: error,
                });
            }
            throw serviceError(error);
        }
    }

    async function updateConfiguration(
        input: UpdateOpenClawConfigurationInput,
        context: OpenClawSettingsControlContext,
        signal?: AbortSignal
    ): Promise<UpdateOpenClawConfigurationResult> {
        const parsed = v.parse(updateOpenClawConfigurationInputSchema, input);
        const targetId =
            parsed.update.section === "agent-tool-access"
                ? `configuration:agent-tool-access:${parsed.update.agentId}:${parsed.update.toolId}`
                : `configuration:${parsed.update.section}`;
        return await withMutationLock(signal, () =>
            withControlAudit("update-configuration", targetId, context, signal, () =>
                executeAuthorizedMutation(
                    context,
                    signal,
                    (authorizeDispatch) =>
                        options.provider.updateConfiguration({
                            ...parsed,
                            authorizeDispatch,
                            ...signalOptions(signal),
                        }),
                    (result) => v.parse(updateOpenClawConfigurationResultSchema, result)
                )
            )
        );
    }

    async function setSkillEnabled(
        input: SetOpenClawSkillEnabledInput,
        context: OpenClawSettingsControlContext,
        signal?: AbortSignal
    ): Promise<SetOpenClawSkillEnabledResult> {
        const parsed = v.parse(setOpenClawSkillEnabledInputSchema, input);
        return await withMutationLock(signal, () =>
            withControlAudit(
                "set-skill-enabled",
                `skill:${parsed.skillKey}`,
                context,
                signal,
                () =>
                    executeAuthorizedMutation(
                        context,
                        signal,
                        (authorizeDispatch) =>
                            options.provider.setSkillEnabled({
                                ...parsed,
                                authorizeDispatch,
                                ...signalOptions(signal),
                            }),
                        (result) => v.parse(setOpenClawSkillEnabledResultSchema, result)
                    )
            )
        );
    }

    return Object.freeze({
        getConfiguration,
        listSkills,
        setSkillEnabled,
        updateConfiguration,
    });
}
