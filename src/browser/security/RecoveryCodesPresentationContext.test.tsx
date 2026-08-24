import { afterEach, describe, expect, test } from "bun:test";

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { RecoveryCodesPresentationProvider } from "./RecoveryCodesPresentationContext.tsx";
import { useRecoveryCodesPresenter } from "./recoveryCodesPresentationContextValue.ts";

const { act, render, screen, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = Date.now();
const currentUser = Object.freeze({
    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
    email: "operator@example.com",
    username: "operator",
});
const otherUser = Object.freeze({
    id: "019fd974-54a2-74dd-a64b-d4186f8d8829",
    email: "operator@example.com",
    username: "other-operator",
});
const codes = Object.freeze([
    "00000000000000000000000000000000-11111111111111111111111111111111",
    "22222222222222222222222222222222-33333333333333333333333333333333",
]);

function authenticatedStatus(
    user: typeof currentUser | typeof otherUser,
    sessionId: string
): AuthStatus {
    return {
        session: {
            authenticatedAtMs: timestampMs,
            authMethod: "password",
            createdAtMs: timestampMs,
            expiresAtMs: timestampMs + 86_400_000,
            id: sessionId,
            isCurrent: true,
            lastSeenAtMs: timestampMs,
            userAgent: "Browser test",
        },
        state: "authenticated",
        user,
    };
}

const pendingMfaStatus: AuthStatus = {
    pendingLogin: {
        expiresAtMs: timestampMs + 300_000,
        methods: ["totp"],
        username: currentUser.username,
    },
    state: "pending-mfa",
};

interface PresentationTriggersProps {
    readonly onCurrentUserResult: (result: boolean) => void;
    readonly onOtherUserResult: (result: boolean) => void;
}

function PresentationTriggers({
    onCurrentUserResult,
    onOtherUserResult,
}: PresentationTriggersProps) {
    const presenter = useRecoveryCodesPresenter();
    return (
        <>
            <button
                onClick={() => {
                    onCurrentUserResult(presenter.present(currentUser.id, codes));
                }}
                type="button"
            >
                Present for current user
            </button>
            <button
                onClick={() => {
                    onOtherUserResult(presenter.present(otherUser.id, codes));
                }}
                type="button"
            >
                Present for other user
            </button>
        </>
    );
}

const queryClients: QueryClient[] = [];

function renderPresentation(status: AuthStatus = authenticatedStatus(currentUser, "a")) {
    const queryClient = createDashboardQueryClient();
    let currentUserResult: boolean | undefined;
    let otherUserResult: boolean | undefined;
    queryClient.setQueryData(authStatusQueryKey, status);
    queryClients.push(queryClient);
    render(
        <QueryClientProvider client={queryClient}>
            <RecoveryCodesPresentationProvider>
                <PresentationTriggers
                    onCurrentUserResult={(result) => {
                        currentUserResult = result;
                    }}
                    onOtherUserResult={(result) => {
                        otherUserResult = result;
                    }}
                />
            </RecoveryCodesPresentationProvider>
        </QueryClientProvider>
    );
    return {
        currentUserResult: () => currentUserResult,
        otherUserResult: () => otherUserResult,
        queryClient,
    };
}

async function waitForDialogExit(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
}

afterEach(() => {
    act(() => {
        for (const queryClient of queryClients.splice(0)) queryClient.clear();
    });
});

describe("RecoveryCodesPresentationProvider", () => {
    test("presents one legacy-style modal outside QueryClient and survives a same-user session rotation", async () => {
        const { currentUserResult, queryClient } = renderPresentation();
        const user = userEvent.setup();

        await user.click(
            screen.getByRole("button", { name: "Present for current user" })
        );

        const dialog = await screen.findByRole("dialog", {
            name: "Save recovery codes now",
        });
        expect(currentUserResult()).toBeTrue();
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(
            within(dialog).getByText(
                "These full codes are shown once. Store them offline. Do not put them in Dashboard notes or screenshots."
            )
        ).toBeTruthy();
        for (const code of codes) expect(within(dialog).getByText(code)).toBeTruthy();
        expect(
            within(dialog).getByRole("button", { name: "Copy recovery codes" })
        ).toBeTruthy();
        expect(within(dialog).getByRole("button", { name: "Download" })).toBeTruthy();

        const serializedQueryCache = JSON.stringify(queryClient.getQueryCache().getAll());
        for (const code of codes) expect(serializedQueryCache).not.toContain(code);

        act(() => {
            queryClient.setQueryData(
                authStatusQueryKey,
                authenticatedStatus(currentUser, "b")
            );
        });

        const rotatedDialog = screen.getByRole("dialog", {
            name: "Save recovery codes now",
        });
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        for (const code of codes) {
            expect(within(rotatedDialog).getByText(code)).toBeTruthy();
        }

        await user.click(
            within(rotatedDialog).getByRole("button", { name: "Close dialog" })
        );
        await waitForDialogExit();
        for (const code of codes) expect(screen.queryByText(code)).toBeNull();
    });

    for (const scenario of [
        { label: "logout", status: { state: "anonymous" } satisfies AuthStatus },
        { label: "pending MFA", status: pendingMfaStatus },
        {
            label: "a different authenticated user",
            status: authenticatedStatus(otherUser, "c"),
        },
    ]) {
        test(`clears the modal on ${scenario.label}`, async () => {
            const { queryClient } = renderPresentation();
            const user = userEvent.setup();
            await user.click(
                screen.getByRole("button", { name: "Present for current user" })
            );
            expect(
                await screen.findByRole("dialog", {
                    name: "Save recovery codes now",
                })
            ).toBeTruthy();

            act(() => {
                queryClient.setQueryData(authStatusQueryKey, scenario.status);
            });

            await waitForDialogExit();
            for (const code of codes) expect(screen.queryByText(code)).toBeNull();
        });
    }

    test("refuses recovery codes initiated for a different user", async () => {
        const { otherUserResult, queryClient } = renderPresentation();
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Present for other user" }));

        expect(otherUserResult()).toBeFalse();
        expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
        for (const code of codes) {
            expect(screen.queryByText(code)).toBeNull();
            expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(
                code
            );
        }
    });
});
