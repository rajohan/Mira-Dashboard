import { describe, expect, test } from "bun:test";

import type { DockerContainer } from "../../contracts/docker.ts";
import {
    dockerContainerHealthLabel,
    dockerUpdaterEventVariant,
    dockerUpdaterStatusLabel,
    formatDockerContainerRuntime,
} from "./dockerPresentation.ts";

function container(overrides: Partial<DockerContainer>): DockerContainer {
    return {
        id: "container-1",
        image: "example/image:latest",
        name: "example",
        state: "exited",
        status: "Exited",
        ...overrides,
    } as DockerContainer;
}

describe("Docker presentation", () => {
    test("uses compact honest copy for absent health and unscanned registries", () => {
        expect(dockerContainerHealthLabel("none")).toBe("Unknown");
        expect(dockerUpdaterStatusLabel({ state: "not-checked" })).toBe("Not checked");
    });

    test("uses semantic updater event badge colors", () => {
        expect(dockerUpdaterEventVariant("scan-completed")).toBe("success");
        expect(dockerUpdaterEventVariant("update-succeeded")).toBe("success");
        expect(dockerUpdaterEventVariant("source-sync-pending")).toBe("warning");
        expect(dockerUpdaterEventVariant("update-available")).toBe("warning");
        expect(dockerUpdaterEventVariant("update-failed")).toBe("danger");
        expect(dockerUpdaterEventVariant("update-outcome-unknown")).toBe("danger");
        expect(dockerUpdaterEventVariant("discovery-failed")).toBe("danger");
        expect(dockerUpdaterEventVariant("scan-failed")).toBe("danger");
    });

    test("does not invent a finish time for an inactive container", () => {
        expect(
            formatDockerContainerRuntime(container({ startedAtMs: 1000 }), 10_000)
        ).toBe("Runtime unavailable");
    });

    test("uses the observation clock only for an active container", () => {
        expect(
            formatDockerContainerRuntime(
                container({ startedAtMs: 1000, state: "running" }),
                61_000
            )
        ).toBe("Up 1 minute");
    });
});
