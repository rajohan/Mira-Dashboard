import { describe, expect, test } from "bun:test";

import type { DockerContainer } from "../../contracts/docker.ts";
import { formatDockerContainerRuntime } from "./dockerPresentation.ts";

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
