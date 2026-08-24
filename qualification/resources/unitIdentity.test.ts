import { describe, expect, test } from "bun:test";

import {
    assertSseMemoryUnitCgroupPath,
    expectedSseMemoryUnitCgroupPath,
} from "./unitIdentity.ts";

const unitName = "mira-dashboard-sse-memory-019fcb3d-6cf6-7000-8000-000000000001";

describe("SSE memory transient-unit identity", () => {
    test("derives and requires the exact app.slice cgroup path", () => {
        const expectedPath = expectedSseMemoryUnitCgroupPath(1000, unitName);
        expect(expectedPath).toBe(
            `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}.service`
        );
        expect(() =>
            assertSseMemoryUnitCgroupPath(expectedPath, expectedPath)
        ).not.toThrow();
        expect(() =>
            assertSseMemoryUnitCgroupPath(
                `/user.slice/user-1000.slice/user@1000.service/background.slice/${unitName}.service`,
                expectedPath
            )
        ).toThrow("expected cgroup");
    });

    test("rejects invalid user and unit identities", () => {
        expect(() => expectedSseMemoryUnitCgroupPath(-1, unitName)).toThrow(
            "user ID is invalid"
        );
        expect(() => expectedSseMemoryUnitCgroupPath(1000, "invalid")).toThrow(
            "unit name is invalid"
        );
    });
});
