import { afterEach, describe, expect, test } from "bun:test";

import { useState } from "react";

import { OperationTrackerProvider } from "./OperationTrackerContext.tsx";
import { useOperationTracker } from "./operationTrackerContextValue.ts";

const { cleanup, render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

afterEach(() => {
    cleanup();
    globalThis.sessionStorage.clear();
});

function Harness() {
    const tracker = useOperationTracker();
    const [terminalRefreshes, setTerminalRefreshes] = useState(0);
    return (
        <div>
            <button
                onClick={() => tracker.track({ jobRunId: "run-1", label: "First" })}
                type="button"
            >
                Track first
            </button>
            <button
                onClick={() => tracker.track({ jobRunId: "run-1", label: "Updated" })}
                type="button"
            >
                Track updated
            </button>
            <button onClick={() => tracker.dismiss("run-1")} type="button">
                Dismiss
            </button>
            <button
                onClick={() => {
                    for (let index = 1; index <= 13; index += 1) {
                        tracker.track({
                            jobRunId: `active-${index}`,
                            label: `Active ${index}`,
                        });
                    }
                }}
                type="button"
            >
                Track active batch
            </button>
            <button onClick={() => tracker.settle("active-1")} type="button">
                Settle oldest
            </button>
            <button
                onClick={() =>
                    tracker.track({
                        jobRunId: "refresh-run",
                        label: "Refresh run",
                        onTerminal: () => setTerminalRefreshes((current) => current + 1),
                    })
                }
                type="button"
            >
                Track refresh
            </button>
            <button onClick={() => tracker.settle("refresh-run")} type="button">
                Settle refresh
            </button>
            <output aria-label="Operations">
                {tracker.operations.map(({ label }) => label).join(",")}
                {` (${tracker.operations.length})`}
            </output>
            <output aria-label="Terminal refreshes">{terminalRefreshes}</output>
        </div>
    );
}

describe("operation tracker", () => {
    test("restores active operations after a provider remount", async () => {
        const user = userEvent.setup();
        const first = render(
            <OperationTrackerProvider>
                <Harness />
            </OperationTrackerProvider>
        );

        await user.click(screen.getByRole("button", { name: "Track first" }));
        first.unmount();
        render(
            <OperationTrackerProvider>
                <Harness />
            </OperationTrackerProvider>
        );

        expect(screen.getByRole("status", { name: "Operations" })).toHaveTextContent(
            "First (1)"
        );
    });

    test("deduplicates durable run identities and dismisses them", async () => {
        const user = userEvent.setup();
        render(
            <OperationTrackerProvider>
                <Harness />
            </OperationTrackerProvider>
        );

        await user.click(screen.getByRole("button", { name: "Track first" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "First"
        );
        await user.click(screen.getByRole("button", { name: "Track updated" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "Updated"
        );
        expect(
            screen.getByRole("status", { name: "Operations" }).textContent
        ).not.toContain("First");
        await user.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toBe(
            " (0)"
        );
    });

    test("keeps every active operation and caps only terminal history", async () => {
        const user = userEvent.setup();
        render(
            <OperationTrackerProvider>
                <Harness />
            </OperationTrackerProvider>
        );

        await user.click(screen.getByRole("button", { name: "Track active batch" }));
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "Active 1"
        );
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "(13)"
        );

        await user.click(screen.getByRole("button", { name: "Settle oldest" }));
        expect(
            screen.getByRole("status", { name: "Operations" }).textContent
        ).not.toContain("Active 1,");
        expect(screen.getByRole("status", { name: "Operations" }).textContent).toContain(
            "(12)"
        );
    });

    test("runs one domain refresh exactly once when a tracked job becomes terminal", async () => {
        const user = userEvent.setup();
        render(
            <OperationTrackerProvider>
                <Harness />
            </OperationTrackerProvider>
        );

        await user.click(screen.getByRole("button", { name: "Track refresh" }));
        await user.click(screen.getByRole("button", { name: "Settle refresh" }));
        await user.click(screen.getByRole("button", { name: "Settle refresh" }));

        expect(
            screen.getByRole("status", { name: "Terminal refreshes" })
        ).toHaveTextContent("1");
    });
});
