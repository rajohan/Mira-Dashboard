import { afterEach, describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type { NotificationRecord } from "../../contracts/monitoring.ts";
import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { notificationLatestQueryKey } from "../notifications/notificationQueries.ts";
import { OverviewNotificationsSection } from "./OverviewNotificationsSection.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;
const initialNotification = Object.freeze({
    id: "019fe300-0000-7000-8000-000000000041",
    kind: "heartbeat",
    message: "Initial reviewed warning.",
    occurredAtMs: timestampMs,
    severity: "warning",
    source: "monitor",
    title: "Initial notification",
} as const satisfies NotificationRecord);
const updatedNotification = Object.freeze({
    ...initialNotification,
    id: "019fe300-0000-7000-8000-000000000042",
    message: "Realtime reviewed error.",
    occurredAtMs: timestampMs + 1000,
    severity: "error",
    title: "Realtime notification",
} as const satisfies NotificationRecord);

function notificationPage(
    notifications: readonly NotificationRecord[],
    readCount: number,
    unreadCount: number
): ListNotificationsResult {
    return { notifications: [...notifications], readCount, unreadCount };
}

type NotificationOutput =
    | Error
    | ListNotificationsResult
    | Promise<ListNotificationsResult>;

class NotificationsOverviewTransport implements DashboardTrpcTransport {
    readonly calls: Array<{ readonly input: unknown; readonly path: string }> = [];
    readonly #outputs: readonly NotificationOutput[];

    constructor(outputs: readonly NotificationOutput[]) {
        this.#outputs = outputs;
    }

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        const index = this.calls.length;
        this.calls.push({ input, path });
        if (path !== "notifications.list") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        const output = this.#outputs[Math.min(index, this.#outputs.length - 1)];
        if (output === undefined) {
            return Promise.reject(new TypeError("Missing notifications output"));
        }
        return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
    }
}

interface SectionHarness {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly transport: NotificationsOverviewTransport;
    readonly view: ReturnType<typeof render>;
}

const harnesses: SectionHarness[] = [];

afterEach(() => {
    for (const { queryClient, view } of harnesses.splice(0)) {
        view.unmount();
        queryClient.clear();
    }
});

function renderSection(outputs: readonly NotificationOutput[]): SectionHarness {
    const queryClient = createDashboardQueryClient();
    queryClient.setDefaultOptions({
        ...queryClient.getDefaultOptions(),
        queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    });
    const transport = new NotificationsOverviewTransport(outputs);
    const trpcClient = createDashboardTrpcClient(transport);
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={trpcClient}>
                <OverviewNotificationsSection />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
    const harness = { queryClient, transport, view };
    harnesses.push(harness);
    return harness;
}

async function refreshLatest(
    queryClient: ReturnType<typeof createDashboardQueryClient>
): Promise<void> {
    await act(async () => {
        await queryClient.invalidateQueries({
            exact: true,
            queryKey: notificationLatestQueryKey,
        });
    });
}

describe("OverviewNotificationsSection", () => {
    test("shares the authoritative newest-window cache without a second realtime owner", async () => {
        const firstPage = Promise.withResolvers<ListNotificationsResult>();
        const harness = renderSection([
            firstPage.promise,
            notificationPage([updatedNotification, initialNotification], 4, 2),
        ]);

        expect(await screen.findByLabelText("Loading notifications…")).toBeTruthy();
        firstPage.resolve(notificationPage([initialNotification], 4, 1));
        expect(await screen.findByText("Initial notification")).toBeTruthy();
        expect(harness.transport.calls[0]).toEqual({
            input: { limit: 100 },
            path: "notifications.list",
        });
        await refreshLatest(harness.queryClient);
        expect(await screen.findByText("Realtime notification")).toBeTruthy();
        expect(harness.transport.calls).toHaveLength(2);
    });

    test("retains exact counts and rows when a background refresh fails", async () => {
        const rawFailure = new TypeError("private notification transport detail");
        const harness = renderSection([
            notificationPage([initialNotification], 4, 1),
            rawFailure,
        ]);
        expect(await screen.findByText("Initial notification")).toBeTruthy();

        await refreshLatest(harness.queryClient);
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(screen.getByText("Initial notification")).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();
    });

    test("recovers an initial safe error through explicit retry", async () => {
        const rawFailure = new TypeError("private initial notification failure");
        renderSection([rawFailure, notificationPage([initialNotification], 4, 1)]);

        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "Notifications unavailable",
            })
        ).toBeTruthy();
        expect(screen.queryByText(rawFailure.message)).toBeNull();

        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() =>
            expect(screen.getByText("Initial notification")).toBeTruthy()
        );
    });
});
