import { useState } from "react";

import type {
    DeliveryRequestOperationInput,
    DeliveryRequestOperationResult,
} from "../../contracts/delivery.ts";
import {
    deliveryGitHubActionKey,
    deliveryJobActionKeyForPayload,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
} from "../../contracts/deliveryWorker.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    operationKeyForJobAction,
    useOperationTracker,
} from "../operations/operationTrackerContextValue.ts";
import type { DeliveryClient } from "./deliveryClient.ts";
import {
    type DeliveryAuthoritySnapshot,
    deliveryOperationIsCurrent,
    type DeliveryOperationPrompt,
} from "./deliveryOperations.ts";
import { deliveryFailureMessage } from "./deliveryPresentation.ts";
import { refreshDeliveryQueries } from "./deliveryQueries.ts";

async function queueDeliveryOperation(
    client: DeliveryClient,
    input: DeliveryRequestOperationInput,
    signal: AbortSignal
): Promise<DeliveryRequestOperationResult> {
    switch (input.operation) {
        case "approve-review": {
            return client.mutation("delivery.approveReview", input, { signal });
        }
        case "create-pull-request-stack": {
            return client.mutation("delivery.createPullRequestStack", input, { signal });
        }
        case "deploy": {
            return client.mutation("delivery.deploy", input, { signal });
        }
        case "merge-pull-request": {
            return client.mutation("delivery.approvePullRequest", input, { signal });
        }
        case "reject-pull-request": {
            return client.mutation("delivery.rejectPullRequest", input, { signal });
        }
        case "rollback-release": {
            return client.mutation("delivery.rollbackRelease", input, { signal });
        }
        case "start-preview": {
            return client.mutation("delivery.startPreview", input, { signal });
        }
        case "stop-preview": {
            return client.mutation("delivery.stopPreview", input, { signal });
        }
        case "update-branch": {
            return client.mutation("delivery.updateBranch", input, { signal });
        }
    }
}

function deliveryFamilyIsBusy(
    actionKey: string | undefined,
    busy: Readonly<{ github: boolean; preview: boolean; production: boolean }>
): boolean {
    switch (actionKey) {
        case deliveryGitHubActionKey: {
            return busy.github;
        }
        case deliveryPreviewActionKey: {
            return busy.preview;
        }
        case deliveryProductionActionKey: {
            return busy.production;
        }
        default: {
            return false;
        }
    }
}

/** @returns One exact Delivery intent from dialog opening through safe retry or enqueue. */
export function useDeliveryOperations(
    client: DeliveryClient,
    currentAuthority: DeliveryAuthoritySnapshot
) {
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const operationTracker = useOperationTracker();
    const [pending, setPending] = useState<DeliveryOperationPrompt>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [result, setResult] = useState<DeliveryRequestOperationResult>();
    const githubBusy = operationTracker.operationIsActive(
        operationKeyForJobAction(deliveryGitHubActionKey)
    );
    const previewBusy = operationTracker.operationIsActive(
        operationKeyForJobAction(deliveryPreviewActionKey)
    );
    const productionBusy = operationTracker.operationIsActive(
        operationKeyForJobAction(deliveryProductionActionKey)
    );
    const pendingActionKey =
        pending === undefined ? undefined : deliveryJobActionKeyForPayload(pending.input);
    const pendingFamilyBusy = deliveryFamilyIsBusy(pendingActionKey, {
        github: githubBusy,
        preview: previewBusy,
        production: productionBusy,
    });
    const confirmationBusy = busy || pendingFamilyBusy;
    const current =
        pending === undefined ||
        deliveryOperationIsCurrent(pending.input, currentAuthority);

    function open(prompt: DeliveryOperationPrompt): void {
        setPending(prompt);
        setError(undefined);
        setResult(undefined);
    }

    function close(): void {
        if (busy) return;
        setPending(undefined);
        setError(undefined);
    }

    async function confirm(): Promise<void> {
        if (pending === undefined || confirmationBusy) return;
        if (!deliveryOperationIsCurrent(pending.input, currentAuthority)) {
            setError("Delivery state changed. Reopen this confirmation.");
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const queued = await mutationBoundary.run((signal) =>
                queueDeliveryOperation(client, pending.input, signal)
            );
            if (!mutationBoundary.completionIsCurrent()) return;
            operationTracker.track({
                jobRunId: queued.jobRunId,
                label: `Delivery: ${queued.operation}`,
                operationKey: operationKeyForJobAction(
                    deliveryJobActionKeyForPayload(pending.input)
                ),
                onTerminal: () => refreshDeliveryQueries(mutationBoundary.queryClient),
            });
            setResult(queued);
            setPending(undefined);
            await refreshDeliveryQueries(mutationBoundary.queryClient);
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                setError(deliveryFailureMessage(error));
            }
        } finally {
            if (mutationBoundary.completionIsCurrent()) setBusy(false);
        }
    }

    return {
        busy: confirmationBusy,
        close,
        confirm,
        current,
        dismissResult: () => setResult(undefined),
        error,
        githubBusy,
        open,
        pending,
        previewBusy,
        productionBusy,
        result,
    };
}
