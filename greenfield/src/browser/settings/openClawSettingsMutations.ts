import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type {
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
    isDashboardOperationOutcomeUnknown,
} from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    openClawConfigurationQueryKey,
    openClawConfigurationQueryOptions,
    openClawSkillsQueryKey,
    openClawSkillsQueryOptions,
} from "./openClawSettingsQueries.ts";

export const openClawSettingsMutationKey = ["openclaw-settings", "mutation"] as const;

export const openClawSettingsUnknownOutcomeMessage =
    "Dashboard could not confirm whether OpenClaw applied the change. Refresh current status before submitting another change.";

function configurationSuccessMessage(
    result: DashboardProcedureOutput<"openClawSettings.updateConfiguration">
): string {
    if (!result.changed) return "OpenClaw already had these settings.";
    if (result.restartRequired && result.restartScheduled) {
        return "Settings saved. OpenClaw scheduled the required Gateway restart.";
    }
    if (result.restartRequired) {
        return "Settings saved. OpenClaw reports that a Gateway restart is still required.";
    }
    return "OpenClaw settings saved.";
}

function mutationFailureMessage(error: unknown): string {
    if (isDashboardOperationOutcomeUnknown(error)) {
        return openClawSettingsUnknownOutcomeMessage;
    }
    if (classifyDashboardBrowserFailure(error) === "conflict") {
        return "OpenClaw configuration changed. Refresh current status before trying again.";
    }
    return dashboardBrowserFailureMessage(error);
}

/**
 * Owns session-generation-bound OpenClaw settings mutations and read-only reconciliation.
 * @returns Exact section/skill mutations plus shared safe feedback and reconciliation state.
 */
export function useOpenClawSettingsMutations() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [reconciliationRequired, setReconciliationRequired] = useState(false);
    const [reconciliationBusy, setReconciliationBusy] = useState(false);
    const [snapshotGeneration, setSnapshotGeneration] = useState(0);
    const restartIdempotencyKey = useRef<string | undefined>(undefined);

    async function refreshCurrentState(successMessage?: string): Promise<boolean> {
        if (!boundary.completionIsCurrent()) return false;
        setReconciliationBusy(true);
        setError(undefined);
        try {
            await Promise.all([
                boundary.queryClient.fetchQuery(
                    openClawConfigurationQueryOptions(client)
                ),
                boundary.queryClient.fetchQuery(openClawSkillsQueryOptions(client)),
            ]);
            if (!boundary.completionIsCurrent()) return false;
            setReconciliationRequired(false);
            setSnapshotGeneration((generation) => generation + 1);
            setNotice(
                successMessage ??
                    "Current OpenClaw state refreshed. Review it before submitting again."
            );
            return true;
        } catch {
            if (!boundary.completionIsCurrent()) return false;
            setReconciliationRequired(true);
            setError(
                "Current OpenClaw state is still unavailable. Settings controls remain locked."
            );
            return false;
        } finally {
            if (boundary.completionIsCurrent()) setReconciliationBusy(false);
        }
    }

    const configuration = useMutation<
        DashboardProcedureOutput<"openClawSettings.updateConfiguration">,
        Error,
        DashboardProcedureInput<"openClawSettings.updateConfiguration">
    >({
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("openClawSettings.updateConfiguration", input, { signal })
            ),
        mutationKey: [...openClawSettingsMutationKey, "configuration"],
        onError: (mutationError) => {
            if (!boundary.completionIsCurrent()) return;
            const requiresReconciliation =
                isDashboardOperationOutcomeUnknown(mutationError) ||
                classifyDashboardBrowserFailure(mutationError) === "conflict";
            setReconciliationRequired(requiresReconciliation);
            setError(mutationFailureMessage(mutationError));
        },
        onMutate: async () => {
            setError(undefined);
            setNotice(undefined);
            await boundary.queryClient.cancelQueries({
                exact: true,
                queryKey: openClawConfigurationQueryKey,
            });
        },
        onSuccess: (result) => {
            if (!boundary.completionIsCurrent()) return;
            boundary.queryClient.setQueryData(
                openClawConfigurationQueryKey,
                result.configuration
            );
            void boundary.queryClient
                .invalidateQueries({
                    exact: true,
                    queryKey: openClawSkillsQueryKey,
                    refetchType: "active",
                })
                .catch(() => {});
            setReconciliationRequired(false);
            setSnapshotGeneration((generation) => generation + 1);
            setNotice(configurationSuccessMessage(result));
        },
        retry: false,
    });

    const skill = useMutation<
        DashboardProcedureOutput<"openClawSettings.setSkillEnabled">,
        Error,
        DashboardProcedureInput<"openClawSettings.setSkillEnabled">
    >({
        mutationFn: (input) =>
            boundary.run((signal) =>
                client.mutation("openClawSettings.setSkillEnabled", input, {
                    signal,
                })
            ),
        mutationKey: [...openClawSettingsMutationKey, "skill"],
        onError: (mutationError) => {
            if (!boundary.completionIsCurrent()) return;
            const requiresReconciliation =
                isDashboardOperationOutcomeUnknown(mutationError) ||
                classifyDashboardBrowserFailure(mutationError) === "conflict";
            setReconciliationRequired(requiresReconciliation);
            setError(mutationFailureMessage(mutationError));
        },
        onMutate: async () => {
            setError(undefined);
            setNotice(undefined);
            await boundary.queryClient.cancelQueries({
                exact: true,
                queryKey: openClawSkillsQueryKey,
            });
        },
        onSuccess: async () => {
            if (!boundary.completionIsCurrent()) return;
            setReconciliationRequired(true);
            await refreshCurrentState(
                "Skill setting saved and confirmed against current OpenClaw state."
            );
        },
        retry: false,
    });

    const backup = useMutation<
        DashboardProcedureOutput<"openClawSettings.createConfigurationBackup">,
        Error,
        void
    >({
        mutationFn: () =>
            boundary.run((signal) =>
                client.mutation(
                    "openClawSettings.createConfigurationBackup",
                    { confirmation: "export-openclaw-configuration" },
                    { signal }
                )
            ),
        mutationKey: [...openClawSettingsMutationKey, "configuration-backup"],
        onError: (mutationError) => {
            if (!boundary.completionIsCurrent()) return;
            setError(dashboardBrowserFailureMessage(mutationError));
        },
        onMutate: () => {
            setError(undefined);
            setNotice(undefined);
        },
        onSuccess: (result) => {
            if (!boundary.completionIsCurrent()) return;
            const anchor = document.createElement("a");
            anchor.download = "";
            anchor.href = result.downloadUrl;
            anchor.rel = "noopener";
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setNotice("OpenClaw configuration backup download started.");
        },
        retry: false,
    });

    const restart = useMutation<
        DashboardProcedureOutput<"openClawSettings.restartGateway">,
        Error,
        void
    >({
        mutationFn: () => {
            const idempotencyKey =
                restartIdempotencyKey.current ?? crypto.randomUUID();
            restartIdempotencyKey.current = idempotencyKey;
            return boundary.run((signal) =>
                client.mutation(
                    "openClawSettings.restartGateway",
                    {
                        confirmation: "restart-openclaw-gateway",
                        idempotencyKey,
                    },
                    { signal }
                )
            );
        },
        mutationKey: [...openClawSettingsMutationKey, "gateway-restart"],
        onError: (mutationError) => {
            if (!boundary.completionIsCurrent()) return;
            setError(mutationFailureMessage(mutationError));
        },
        onMutate: () => {
            setError(undefined);
            setNotice(undefined);
        },
        onSuccess: () => {
            if (!boundary.completionIsCurrent()) return;
            restartIdempotencyKey.current = undefined;
            setNotice("OpenClaw Gateway restart completed.");
        },
        retry: false,
    });

    return {
        backup,
        clearError: () => setError(undefined),
        clearNotice: () => setNotice(undefined),
        configuration,
        error,
        isBusy:
            backup.isPending ||
            configuration.isPending ||
            restart.isPending ||
            skill.isPending ||
            reconciliationBusy,
        notice,
        reconcile: () => refreshCurrentState(),
        reconciliationBusy,
        reconciliationRequired,
        restart,
        skill,
        snapshotGeneration,
    };
}
