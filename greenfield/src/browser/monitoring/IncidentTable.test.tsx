import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import type { IncidentSummary } from "../../contracts/monitoring.ts";
import { IncidentTable } from "./IncidentTable.tsx";

const { render, screen } = await import("@testing-library/react");

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

const incidents: readonly IncidentSummary[] = Object.freeze(
    Array.from({ length: 50 }, (_, index): IncidentSummary => ({
        fingerprint: index.toString(16).padStart(64, "0"),
        firstSeenAtMs: 1_800_000_000_000 - index * 1000,
        generation: 1,
        id: `incident-${index}`,
        kind: "filesystem",
        lastSeenAtMs: 1_800_000_001_000 - index * 1000,
        monitorKey: `monitor-${index}`,
        occurrenceCount: 1,
        severity: "warning",
        state: "active",
        title: `Incident ${index}`,
    }))
);

describe("incident table", () => {
    test("uses a bounded virtual row window when the catalog reaches its threshold", () => {
        const onSelect = jest.fn();
        const view = render(
            <IncidentTable
                incidents={incidents}
                onSelect={onSelect}
                selectedId={incidents[1]!.id}
            />
        );

        const table = screen.getByRole("table", { name: "Incidents" });
        expect(
            screen.getByRole("button", {
                name: "Incident 0; monitor-0; occurrence group 1",
            })
        ).toBeTruthy();
        expect(screen.queryByText("Incident 49")).toBeNull();
        expect(table.querySelector("td[height]")).toBeTruthy();
        view.unmount();
    });
});
