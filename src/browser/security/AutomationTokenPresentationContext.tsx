import { useQueryClient } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    automationTokenPresentationContext as AutomationTokenPresentationContext,
    type AutomationTokenPresenter,
} from "./automationTokenPresentationContextValue.ts";

const LazyAutomationTokenModal = lazy(async () => {
    const module = await import("./AutomationTokenModal.tsx");
    return { default: module.AutomationTokenModal };
});

interface AutomationTokenPresentation {
    readonly ownerUserId: string;
    readonly token: string;
}

interface AutomationTokenPresentationProviderProps {
    readonly children: ReactNode;
}

interface AutomationTokenPresentationOwnerProps {
    readonly children: ReactNode;
    readonly ownerUserId: string | undefined;
}

function AutomationTokenPresentationOwner({
    children,
    ownerUserId,
}: AutomationTokenPresentationOwnerProps) {
    const queryClient = useQueryClient();
    const [presentation, setPresentation] = useState<AutomationTokenPresentation>();
    const presenter: AutomationTokenPresenter = {
        present(expectedOwnerUserId, token) {
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
            setPresentation({ ownerUserId: expectedOwnerUserId, token });
            return true;
        },
    };

    return (
        <AutomationTokenPresentationContext value={presenter}>
            {children}
            {presentation !== undefined && (
                <Suspense fallback={null}>
                    <LazyAutomationTokenModal
                        onClose={() => setPresentation(undefined)}
                        token={presentation.token}
                    />
                </Suspense>
            )}
        </AutomationTokenPresentationContext>
    );
}

/**
 * Owns one-time automation tokens outside the authenticated cache boundary so a
 * planned same-user session rotation cannot discard them before they are saved.
 * @returns Children and the application-wide transient automation-token presenter.
 */
export function AutomationTokenPresentationProvider({
    children,
}: AutomationTokenPresentationProviderProps) {
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    const currentUserId =
        authentication?.state === "authenticated" ? authentication.user.id : undefined;

    return (
        <AutomationTokenPresentationOwner
            key={currentUserId ?? "no-authenticated-user"}
            ownerUserId={currentUserId}
        >
            {children}
        </AutomationTokenPresentationOwner>
    );
}
