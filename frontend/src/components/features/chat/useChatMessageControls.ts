import { useEffect, useRef, useState } from "react";

import {
    addDeletedMessageKeys,
    readDeletedMessageKeys,
    writeDeletedMessageKeys,
} from "./chatPageUtilities";

/**
 * Owns local message deletion and asynchronous session-reset confirmation.
 * @param selectedSessionKey Current chat session key.
 * @param initialObservedSessionKey Session key observed during initial render.
 * @returns Message deletion and session reset confirmation controls.
 */
export function useChatMessageControls(
    selectedSessionKey: string,
    initialObservedSessionKey = selectedSessionKey
) {
    const resetConfirmResolverRef = useRef<((wasConfirmed: boolean) => void) | undefined>(
        undefined
    );
    const [deletedMessageKeys, setDeletedMessageKeys] = useState<Set<string>>(
        () => new Set()
    );
    const [pendingDeleteMessageKeys, setPendingDeleteMessageKeys] = useState<string[]>(
        []
    );
    const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
    const [observedSessionKey, setObservedSessionKey] = useState(
        initialObservedSessionKey
    );

    if (observedSessionKey !== selectedSessionKey) {
        setObservedSessionKey(selectedSessionKey);
        setDeletedMessageKeys(
            selectedSessionKey ? readDeletedMessageKeys(selectedSessionKey) : new Set()
        );
        setPendingDeleteMessageKeys([]);
    }

    const requestMessageDeletion = (
        messageKey: string,
        deleteKeys?: readonly string[]
    ) => {
        setPendingDeleteMessageKeys(deleteKeys?.length ? [...deleteKeys] : [messageKey]);
    };

    const confirmMessageDeletion = () => {
        if (!selectedSessionKey || pendingDeleteMessageKeys.length === 0) return;
        setDeletedMessageKeys((previous) => {
            const next = addDeletedMessageKeys(previous, pendingDeleteMessageKeys);
            writeDeletedMessageKeys(selectedSessionKey, next);
            return next;
        });
        setPendingDeleteMessageKeys([]);
    };

    const closeResetConfirmation = (wasConfirmed: boolean) => {
        resetConfirmResolverRef.current?.(wasConfirmed);
        resetConfirmResolverRef.current = undefined;
        setIsResetConfirmOpen(false);
    };

    const confirmResetSession = () =>
        new Promise<boolean>((resolve) => {
            resetConfirmResolverRef.current?.(false);
            resetConfirmResolverRef.current = resolve;
            setIsResetConfirmOpen(true);
        });

    useEffect(() => {
        return () => {
            resetConfirmResolverRef.current?.(false);
            resetConfirmResolverRef.current = undefined;
        };
    }, []);

    return {
        cancelMessageDeletion: () => setPendingDeleteMessageKeys([]),
        closeResetConfirmation,
        confirmMessageDeletion,
        confirmResetSession,
        deletedMessageKeys,
        isDeleteConfirmationOpen: pendingDeleteMessageKeys.length > 0,
        isResetConfirmOpen,
        requestMessageDeletion,
    };
}
