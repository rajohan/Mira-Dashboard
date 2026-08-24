import { describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";

import type { AutomationPrincipalSummary } from "../../contracts/automationSecurity.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { AutomationPrincipalCard } from "./AutomationPrincipalCard.tsx";

const { render, screen } = await import("@testing-library/react");

const timestampMs = Date.now();
const principal = Object.freeze({
    activeCredentialCount: 0,
    authorizationVersion: 1,
    capabilities: ["notifications:read"],
    createdAtMs: timestampMs,
    disabled: false,
    id: "openclaw-heartbeat",
    label: "OpenClaw heartbeat",
    totalCredentialCount: 0,
    updatedAtMs: timestampMs,
} satisfies AutomationPrincipalSummary);

function principalCard(
    queryClient: ReturnType<typeof createDashboardQueryClient>,
    currentPrincipal: AutomationPrincipalSummary
) {
    const client = createDashboardTrpcClient({
        mutation() {
            return Promise.reject(new TypeError("Unexpected mutation"));
        },
        query(path, input) {
            if (path !== "automationSecurity.listCredentials") {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
            return Promise.resolve({
                credentials: [],
                principalId:
                    typeof input === "object" &&
                    input !== null &&
                    "principalId" in input &&
                    typeof input.principalId === "string"
                        ? input.principalId
                        : currentPrincipal.id,
                totalCredentialCount: 0,
            });
        },
    });
    return (
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <ul>
                    <AutomationPrincipalCard principal={currentPrincipal} />
                </ul>
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
}

describe("automation principal card", () => {
    test("resets its capability draft when the server version changes", () => {
        const queryClient = createDashboardQueryClient();
        const rendered = render(principalCard(queryClient, principal));

        try {
            expect(
                screen.getByRole("checkbox", { name: "notifications:read" })
            ).toBeChecked();
            expect(
                screen.getByRole("checkbox", { name: "reports:read" })
            ).not.toBeChecked();

            rendered.rerender(
                principalCard(queryClient, {
                    ...principal,
                    authorizationVersion: 2,
                    capabilities: ["reports:read"],
                    updatedAtMs: timestampMs + 1000,
                })
            );

            expect(screen.getByRole("checkbox", { name: "reports:read" })).toBeChecked();
            expect(
                screen.getByRole("checkbox", { name: "notifications:read" })
            ).not.toBeChecked();
        } finally {
            queryClient.clear();
        }
    });
});
