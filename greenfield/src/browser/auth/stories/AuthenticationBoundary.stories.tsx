import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { QueryClientProvider, useIsFetching } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { AuthStatus } from "../../../contracts/auth.ts";
import { createDashboardQueryClient } from "../../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../../api/trpcContext.tsx";
import { Button } from "../../ui/Button.tsx";
import { Input } from "../../ui/Input.tsx";
import { AuthenticatedSessionActivity } from "../AuthenticatedSessionActivity.tsx";
import { AuthenticationBoundary } from "../AuthenticationBoundary.tsx";
import { authStatusQueryKey } from "../authQueries.ts";

const authenticatedStatus = {
    session: {
        authenticatedAtMs: Date.now(),
        authMethod: "password",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: Date.now(),
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
} satisfies AuthStatus;

class DeferredStoryAuthenticationTransport implements DashboardTrpcTransport {
    #statusRequest: PromiseWithResolvers<AuthStatus> | undefined;
    readonly #statusRequestObserved: (count: number) => void;
    #statusRequestCount = 0;

    constructor(statusRequestObserved: (count: number) => void) {
        this.#statusRequestObserved = statusRequestObserved;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string): Promise<unknown> {
        if (path !== "auth.status") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        this.#statusRequestCount += 1;
        this.#statusRequestObserved(this.#statusRequestCount);
        return this.#statusRequest?.promise ?? Promise.resolve(authenticatedStatus);
    }

    deferNextStatus(): void {
        this.#statusRequest = Promise.withResolvers<AuthStatus>();
    }

    resolveStatus(): void {
        this.#statusRequest?.resolve(authenticatedStatus);
        this.#statusRequest = undefined;
    }
}

function RouteMarker() {
    const [mountMarker] = useState(() => crypto.randomUUID());

    return (
        <section
            aria-label="Authenticated route fixture"
            className="min-h-[100rem] space-y-4 p-6"
            data-mount-marker={mountMarker}
        >
            <h1 className="text-xl font-bold">Authenticated route</h1>
            <Input aria-label="Route draft" placeholder="Type a draft" />
        </section>
    );
}

function SessionCheckState() {
    const sessionChecks = useIsFetching({
        exact: true,
        queryKey: authStatusQueryKey,
    });
    return <output aria-label="Active session checks">{sessionChecks}</output>;
}

function AuthenticationBoundaryStory() {
    const [statusRequestCount, setStatusRequestCount] = useState(0);
    const [queryClient] = useState(() => createDashboardQueryClient());
    const [transport] = useState(
        () => new DeferredStoryAuthenticationTransport(setStatusRequestCount)
    );
    const [client] = useState(() => createDashboardTrpcClient(transport));

    if (queryClient.getQueryData(authStatusQueryKey) === undefined) {
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus);
    }

    useEffect(() => () => queryClient.clear(), [queryClient]);

    return (
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <AuthenticatedSessionActivity />
                <div className="bg-primary-950 text-primary-50 flex h-screen flex-col gap-3 p-4">
                    <div className="flex items-center gap-3">
                        <Button
                            onClick={() => transport.deferNextStatus()}
                            size="sm"
                            variant="secondary"
                        >
                            Hold next session check
                        </Button>
                        <Button
                            onClick={() => transport.resolveStatus()}
                            size="sm"
                            variant="secondary"
                        >
                            Finish session check
                        </Button>
                        <span>
                            Requests:{" "}
                            <output aria-label="Session check requests">
                                {statusRequestCount}
                            </output>
                        </span>
                        <span>
                            Active: <SessionCheckState />
                        </span>
                    </div>
                    <main
                        className="border-primary-700 bg-primary-900 min-h-0 flex-1 overflow-y-auto border"
                        data-scroll-restoration-id="dashboard-content"
                        id="dashboard-content"
                    >
                        <AuthenticationBoundary>
                            <RouteMarker />
                        </AuthenticationBoundary>
                    </main>
                </div>
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
}

const meta = {
    component: AuthenticationBoundaryStory,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AuthenticationBoundaryStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const KeepsTheRouteVisibleDuringAStatusRefresh: Story = {
    globals: { viewport: { isRotated: false, value: "desktop1280" } },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const input = await canvas.findByRole<HTMLInputElement>("textbox", {
            name: "Route draft",
        });
        const routeMarker = canvas.getByRole("region", {
            name: "Authenticated route fixture",
        });
        const mountMarker = routeMarker.dataset.mountMarker;
        const content = canvasElement.querySelector<HTMLElement>("#dashboard-content");
        if (content === null) throw new Error("Dashboard content scroller is missing.");
        const href = globalThis.location.href;

        await userEvent.type(input, "Unsaved route state");
        content.scrollTop = 480;
        content.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitFor(async () => {
            await expect(content.scrollTop).toBe(480);
        });

        const requestOutput = canvas.getByRole("status", {
            name: "Session check requests",
        });
        const initialRequestCount = Number(requestOutput.textContent);
        await userEvent.click(
            canvas.getByRole("button", { name: "Hold next session check" })
        );
        globalThis.dispatchEvent(new Event("focus"));

        await waitFor(async () => {
            await expect(Number(requestOutput.textContent)).toBeGreaterThan(
                initialRequestCount
            );
            await expect(
                canvas.getByRole("status", { name: "Active session checks" })
            ).toHaveTextContent("1");
        });
        await expect(input).toBeVisible();
        await expect(input).toHaveValue("Unsaved route state");
        await expect(routeMarker).toBe(
            canvas.getByRole("region", { name: "Authenticated route fixture" })
        );
        await expect(routeMarker.dataset.mountMarker).toBe(mountMarker);
        await expect(content.scrollTop).toBe(480);
        await expect(globalThis.location.href).toBe(href);

        await userEvent.click(
            canvas.getByRole("button", { name: "Finish session check" })
        );
        await waitFor(async () => {
            await expect(
                canvas.getByRole("status", { name: "Active session checks" })
            ).toHaveTextContent("0");
        });
        await expect(input).toBeVisible();
        await expect(content.scrollTop).toBe(480);
    },
};
