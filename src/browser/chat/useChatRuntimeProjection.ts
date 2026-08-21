import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    adaptChatRuntimeEvent,
    projectChatExternalRun,
    projectChatRuntimeSnapshot,
} from "./chatContractAdapter.ts";
import {
    type ChatRuntimeBatch,
    chatHistoryQueryKey,
    chatRuntimeQueryOptions,
} from "./chatQueries.ts";
import type { ChatRuntimeStore } from "./chatRuntimeStore.ts";

interface ChatRuntimeBatchApplication {
    readonly cursor: number;
    readonly historyMayHaveChanged: boolean;
    readonly previousCursor: number;
}

/**
 * Applies one contract-validated runtime read to the authenticated reducer store.
 * The operation is idempotent, so a mutation-owned read and the query observer may
 * safely apply the same batch.
 * @param batch The validated runtime batch to reduce.
 * @param runtimeStore The authenticated application-owned runtime store.
 * @returns Cursor and history-invalidation metadata from the reduction.
 */
export function applyChatRuntimeBatch(
    batch: ChatRuntimeBatch,
    runtimeStore: ChatRuntimeStore
): ChatRuntimeBatchApplication {
    const sessionKey = batch.sessionKey;
    const previousCursor = runtimeStore.cursorFor(sessionKey);
    const previousSession = runtimeStore.state.sessions[sessionKey];
    runtimeStore.setConnection("connected");
    const cursor = Number(batch.cursor);
    const snapshots = batch.runs.map(projectChatRuntimeSnapshot);
    const externalRuns = batch.externalRuns.map((run) => projectChatExternalRun(run));
    const newlyOmittedProjectionDetail =
        (batch.externalRunsTruncated &&
            previousSession?.externalRunsTruncated !== true) ||
        batch.externalRuns.some(
            ({ projectionTruncated, providerRunId }) =>
                projectionTruncated &&
                previousSession?.externalRuns[providerRunId]?.projectionTruncated !== true
        ) ||
        batch.runs.some(
            ({ projectionTruncated, run }) =>
                projectionTruncated &&
                previousSession?.runs[run.id]?.projectionTruncated !== true
        );
    if (batch.resetRequired) {
        runtimeStore.installSnapshots(
            sessionKey,
            snapshots,
            cursor,
            true,
            batch.transcriptGeneration
        );
        runtimeStore.installExternalRuns(
            sessionKey,
            externalRuns,
            batch.externalRunsTruncated
        );
        return { cursor, historyMayHaveChanged: true, previousCursor };
    }
    let historyMayHaveChanged = newlyOmittedProjectionDetail;
    for (const delivery of batch.events) {
        runtimeStore.apply(
            adaptChatRuntimeEvent(sessionKey, delivery.cursor, delivery.event)
        );
        historyMayHaveChanged ||=
            delivery.event.kind === "reconciled" || delivery.event.kind === "terminal";
    }
    runtimeStore.installSnapshots(
        sessionKey,
        snapshots,
        cursor,
        false,
        batch.transcriptGeneration
    );
    runtimeStore.installExternalRuns(
        sessionKey,
        externalRuns,
        batch.externalRunsTruncated
    );
    return { cursor, historyMayHaveChanged, previousCursor };
}

/**
 * Fetches and reduces one bounded runtime delta or authoritative snapshot.
 * @param client Validating browser tRPC client.
 * @param sessionKey Exact selected provider session.
 * @param runtimeStore Tab-local ordered reducer store.
 * @returns Runtime query state for connection/error presentation.
 */
export function useChatRuntimeProjection(
    client: DashboardTrpcClient,
    sessionKey: string,
    runtimeStore: ChatRuntimeStore
) {
    const queryClient = useQueryClient();
    const query = useQuery(
        chatRuntimeQueryOptions(
            client,
            sessionKey,
            () => String(runtimeStore.cursorFor(sessionKey)),
            () => runtimeStore.transcriptGenerationFor(sessionKey)
        )
    );
    const { data, dataUpdatedAt, error, refetch } = query;

    useEffect(() => {
        const batch = data;
        if (batch === undefined || batch.sessionKey !== sessionKey) return;
        let disposed = false;
        const application = applyChatRuntimeBatch(batch, runtimeStore);
        if (application.historyMayHaveChanged) {
            void queryClient.invalidateQueries({
                exact: true,
                queryKey: chatHistoryQueryKey(sessionKey),
            });
        }
        if (batch.hasMore && application.cursor > application.previousCursor) {
            queueMicrotask(() => {
                if (!disposed) void refetch({ cancelRefetch: false });
            });
        }
        return () => {
            disposed = true;
        };
    }, [data, dataUpdatedAt, queryClient, refetch, runtimeStore, sessionKey]);

    useEffect(() => {
        if (error !== null) runtimeStore.setConnection("disconnected");
    }, [error, runtimeStore]);

    return query;
}
