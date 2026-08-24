import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
import { JobRunTable } from "./JobRunTable.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
);
const hadOwnResizeObserver = Object.hasOwn(globalThis, "ResizeObserver");
const originalResizeObserver = Reflect.get(globalThis, "ResizeObserver");

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get: () => 480,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get: () => 960,
    });
    Reflect.set(globalThis, "ResizeObserver", undefined);
});

afterAll(() => {
    if (originalOffsetHeight === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
        Object.defineProperty(
            HTMLElement.prototype,
            "offsetHeight",
            originalOffsetHeight
        );
    }
    if (originalOffsetWidth === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    } else {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    }
    if (hadOwnResizeObserver) {
        Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
    } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
});

const timestampMs = 1_800_000_000_000;

function jobRun(index: number): JobRunSummary {
    const queuedAtMs = timestampMs - index * 1000;
    return {
        actionKey: `maintenance.job-${index}`,
        attemptCount: 0,
        attemptLimit: 3,
        availableAtMs: queuedAtMs,
        cancellationPolicy: "queued-only",
        displayName: `Durable job ${index}`,
        eventCount: 1,
        id: `019fdd00-0000-7000-8000-${index.toString().padStart(12, "0")}`,
        priority: index % 3,
        queuedAtMs,
        resourceClass: "light",
        resourceKeys: [],
        retrySafe: true,
        state: "queued",
        stateVersion: 1,
        timeoutMs: 60_000,
        triggerType: "system",
        updatedAtMs: queuedAtMs,
    };
}

describe("job run table", () => {
    test("renders a clear empty state", () => {
        render(<JobRunTable onSelect={() => {}} runs={[]} />);

        expect(screen.getByRole("heading", { name: "No job runs" })).toBeTruthy();
        expect(screen.queryByRole("table", { name: "Durable job runs" })).toBeNull();
    });

    test("selects a labelled run and virtualizes a maximum-sized page", async () => {
        const runs = Array.from({ length: 50 }, (_, index) => jobRun(index));
        runs[1] = {
            ...runs[1]!,
            actionKey: runs[0]!.actionKey,
            displayName: runs[0]!.displayName,
        };
        const onSelect = jest.fn();
        const view = render(
            <JobRunTable onSelect={onSelect} runs={runs} selectedId={runs[1].id} />
        );
        const user = userEvent.setup();

        const firstRun = screen.getByRole("button", {
            name: `Open run Durable job 0; action maintenance.job-0; id ${runs[0]!.id}`,
        });
        expect(screen.getByRole("table", { name: "Durable job runs" })).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: `Open run Durable job 0; action maintenance.job-0; id ${runs[1].id}`,
            })
        ).toHaveAttribute("aria-current", "true");
        expect(screen.queryByText("Durable job 49")).toBeNull();
        expect(
            screen
                .getByRole("table", { name: "Durable job runs" })
                .querySelector("td[height]")
        ).toBeTruthy();

        await user.click(firstRun);
        expect(onSelect).toHaveBeenCalledWith(runs[0]!.id);
        view.unmount();
    });
});
