import { useState } from "react";

import type {
    DeliveryRequestOperationInput,
    DeliveryRequestOperationResult,
} from "../../contracts/delivery.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { useOperationTracker } from "../operations/operationTrackerContextValue.ts";
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
        if (pending === undefined || busy) return;
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
        busy,
        close,
        confirm,
        current,
        dismissResult: () => setResult(undefined),
        error,
        open,
        pending,
        result,
    };
}
