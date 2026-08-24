import { useQueryClient } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    recoveryCodesPresentationContext as RecoveryCodesPresentationContext,
    type RecoveryCodesPresenter,
} from "./recoveryCodesPresentationContextValue.ts";

const LazyRecoveryCodesModal = lazy(async () => {
    const module = await import("./RecoveryCodesModal.tsx");
    return { default: module.RecoveryCodesModal };
});

interface RecoveryCodesPresentation {
    readonly codes: readonly string[];
    readonly ownerUserId: string;
}

interface RecoveryCodesPresentationProviderProps {
    readonly children: ReactNode;
}

interface RecoveryCodesPresentationOwnerProps {
    readonly children: ReactNode;
    readonly ownerUserId: string | undefined;
}

function RecoveryCodesPresentationOwner({
    children,
    ownerUserId,
}: RecoveryCodesPresentationOwnerProps) {
    const queryClient = useQueryClient();
    const [presentation, setPresentation] = useState<RecoveryCodesPresentation>();
    const presenter: RecoveryCodesPresenter = {
        present(expectedOwnerUserId, codes) {
            const current = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (
                ownerUserId === undefined ||
                expectedOwnerUserId !== ownerUserId ||
                current?.state !== "authenticated" ||
                current.user.id !== expectedOwnerUserId
            ) {
                setPresentation(undefined);
                return false;
            }
            setPresentation({
                codes: Object.freeze([...codes]),
                ownerUserId: expectedOwnerUserId,
            });
            return true;
        },
    };

    return (
        <RecoveryCodesPresentationContext value={presenter}>
            {children}
            {presentation !== undefined && (
                <Suspense fallback={null}>
                    <LazyRecoveryCodesModal
                        codes={presentation.codes}
                        onClose={() => setPresentation(undefined)}
                    />
                </Suspense>
            )}
        </RecoveryCodesPresentationContext>
    );
}

/**
 * Owns one-time recovery codes outside the authenticated cache boundary so a
 * planned same-user session rotation cannot discard them before they are saved.
 * @returns Children and the application-wide transient recovery-code presenter.
 */
export function RecoveryCodesPresentationProvider({
    children,
}: RecoveryCodesPresentationProviderProps) {
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    const currentUserId =
        authentication?.state === "authenticated" ? authentication.user.id : undefined;

    return (
        <RecoveryCodesPresentationOwner
            key={currentUserId ?? "no-authenticated-user"}
            ownerUserId={currentUserId}
        >
            {children}
        </RecoveryCodesPresentationOwner>
    );
}
