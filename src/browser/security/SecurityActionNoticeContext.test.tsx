import { afterEach, describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { SecurityActionNoticeProvider } from "./SecurityActionNoticeContext.tsx";
import {
    type SecurityActionNotice,
    useSecurityActionNotice,
} from "./securityActionNoticeContextValue.ts";

const { act, cleanup, render, screen } = await import("@testing-library/react");

const timestampMs = Date.now();
function authenticatedStatus(userId: string, sessionId: string): AuthStatus {
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
        user: {
            email: "operator@example.com",
            emailVerified: true,
            id: userId,
            username: "operator",
        },
    };
}

interface NoticeConsumerProps {
    readonly onNotice: (notice: SecurityActionNotice) => void;
}

function NoticeConsumer({ onNotice }: NoticeConsumerProps) {
    const notice = useSecurityActionNotice("password");
    useEffect(() => onNotice(notice), [notice, onNotice]);
    return <output>{notice.notice}</output>;
}

afterEach(cleanup);

describe("SecurityActionNoticeProvider", () => {
    test("retains completion through same-user rotation and clears it for another user", () => {
        const queryClient = createDashboardQueryClient();
        const userId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
        let captured: SecurityActionNotice | undefined;
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus(userId, "a"));
        render(
            <QueryClientProvider client={queryClient}>
                <SecurityActionNoticeProvider>
                    <NoticeConsumer
                        onNotice={(notice) => {
                            captured = notice;
                        }}
                    />
                </SecurityActionNoticeProvider>
            </QueryClientProvider>
        );

        act(() => captured?.present("Password changed."));
        expect(screen.getByText("Password changed.")).toBeTruthy();
        act(() => {
            queryClient.setQueryData(
                authStatusQueryKey,
                authenticatedStatus(userId, "b")
            );
        });
        expect(screen.getByText("Password changed.")).toBeTruthy();
        act(() => {
            queryClient.setQueryData(
                authStatusQueryKey,
                authenticatedStatus("019fd974-54a2-74dd-a64b-d4186f8d8829", "c")
            );
        });
        expect(screen.queryByText("Password changed.")).toBeNull();
        act(() => queryClient.clear());
    });
});
