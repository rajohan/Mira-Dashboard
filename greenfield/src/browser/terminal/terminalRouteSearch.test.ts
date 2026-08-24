import { describe, expect, test } from "bun:test";

import { parseTerminalRouteSearch } from "./terminalRouteSearch.ts";

describe("Terminal route search", () => {
    test("accepts only one exact Docker container ID", () => {
        const containerId = "a".repeat(64);

        expect(parseTerminalRouteSearch({ dockerContainerId: containerId })).toEqual({
            dockerContainerId: containerId,
        });
        expect(parseTerminalRouteSearch({ dockerContainerId: "short" })).toEqual({});
        expect(
            parseTerminalRouteSearch({
                dockerContainerId: `${containerId};touch /tmp/unsafe`,
            })
        ).toEqual({});
        expect(parseTerminalRouteSearch({ ignored: containerId })).toEqual({});
    });
});
