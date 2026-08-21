import { describe, expect, test } from "bun:test";

import {
    createProcessTerminationController,
    type DashboardTerminationSignal,
    type ListenForTerminationSignal,
} from "./processSignals.ts";

function signalFixture() {
    const listeners = new Map<DashboardTerminationSignal, () => void>();
    const removed: DashboardTerminationSignal[] = [];
    const listen: ListenForTerminationSignal = (signal, listener) => {
        listeners.set(signal, listener);
        return () => {
            listeners.delete(signal);
            removed.push(signal);
        };
    };
    return { listen, listeners, removed };
}

describe("process termination controller", () => {
    test("starts gracefully on the first signal and escalates on the second", async () => {
        const fixture = signalFixture();
        const controller = createProcessTerminationController(fixture.listen);

        fixture.listeners.get("SIGTERM")?.();
        expect(await controller.termination).toBe("SIGTERM");
        expect(controller.forceSignal.aborted).toBe(false);

        fixture.listeners.get("SIGINT")?.();
        expect(controller.forceSignal.aborted).toBe(true);
        expect(controller.forceSignal.reason).toBeInstanceOf(DOMException);
    });

    test("removes listeners exactly once and ignores later callbacks", () => {
        const fixture = signalFixture();
        const controller = createProcessTerminationController(fixture.listen);
        const sigterm = fixture.listeners.get("SIGTERM");

        controller.dispose();
        controller.dispose();
        sigterm?.();

        expect(fixture.removed.toSorted()).toEqual(["SIGINT", "SIGTERM"]);
        expect(controller.forceSignal.aborted).toBe(false);
    });
});
