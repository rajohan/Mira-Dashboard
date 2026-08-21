import { useQuery } from "@tanstack/react-query";

import type {
    GatewaySession,
    GatewaySessionAction,
    GatewaySessionActionResult,
} from "../../contracts/gatewaySessions.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
    isDashboardOperationOutcomeUnknown,
} from "../api/trpcError.ts";
import { PageState } from "../ui/PageState.tsx";
import { useGatewaySessionMutation } from "./gatewaySessionMutations.ts";
import { gatewaySessionQueryOptions } from "./gatewaySessionQueries.ts";
import { GatewaySessionsView } from "./GatewaySessionsView.tsx";

function gatewaySessionActionFailureMessage(error: unknown): string {
    if (isDashboardOperationOutcomeUnknown(error)) {
        return "We could not confirm whether that action finished. Refresh the session list before trying again.";
    }
    switch (classifyDashboardBrowserFailure(error)) {
        case "not-found": {
            return "That OpenClaw session no longer exists. Review the current list and choose another session.";
        }
        case "conflict": {
            return "The OpenClaw session changed before the action finished. Review the current list and try again.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}

/** @returns Polled current-session snapshot with cache-preserving explicit controls. */
export function GatewaySessionsBrowser() {
    const client = useDashboardTrpcClient();
    const query = useQuery(gatewaySessionQueryOptions(client));
    const { mutation, reconcileUnknownOutcome } = useGatewaySessionMutation();

    if (query.isPending && query.data === undefined) {
        return <PageState label="Loading OpenClaw sessions…" status="loading" />;
    }
    if (query.data === undefined) {
        return (
            <PageState
                message={dashboardBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="OpenClaw sessions unavailable"
            />
        );
    }

    async function runAction(
        action: GatewaySessionAction,
        session: GatewaySession
    ): Promise<GatewaySessionActionResult> {
        mutation.reset();
        if (action === "delete") {
            if (session.sessionId === undefined) {
                throw new Error("Gateway session generation is unavailable");
            }
            return mutation.mutateAsync({
                action,
                expectedSessionId: session.sessionId,
                ...(session.updatedAtMs === undefined
                    ? {}
                    : { expectedUpdatedAtMs: session.updatedAtMs }),
                key: session.key,
            });
        }
        return mutation.mutateAsync({ action, key: session.key });
    }

    async function reconcileUnknownAction(): Promise<boolean> {
        const reconciled = await reconcileUnknownOutcome();
        if (reconciled) mutation.reset();
        return reconciled;
    }

    return (
        <GatewaySessionsView
            actionError={
                mutation.error === null
                    ? undefined
                    : gatewaySessionActionFailureMessage(mutation.error)
            }
            actionPending={mutation.isPending}
            backgroundUnavailable={query.error !== null}
            onAction={runAction}
            onReconcileUnknown={reconcileUnknownAction}
            snapshot={query.data}
        />
    );
}
