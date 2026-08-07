import { describe, expect, test } from "bun:test";

import { ancestorCgroupV2Paths } from "./cgroupV2Hierarchy.ts";

describe("cgroup v2 hierarchy", () => {
    test("derives every controller-bearing ancestor below the root", () => {
        expect(
            ancestorCgroupV2Paths(
                "/user.slice/user-1001.slice/user@1001.service/app.slice/probe.service"
            )
        ).toEqual([
            "/user.slice/user-1001.slice/user@1001.service/app.slice",
            "/user.slice/user-1001.slice/user@1001.service",
            "/user.slice/user-1001.slice",
            "/user.slice",
        ]);
    });

    test("rejects root, relative, and nonnormalized membership paths", () => {
        for (const cgroupPath of ["/", "relative", "/user.slice/../escape"]) {
            expect(() => ancestorCgroupV2Paths(cgroupPath)).toThrow(
                "normalized leaf path"
            );
        }
    });

    test("rejects a leaf directly below the unified root", () => {
        expect(() => ancestorCgroupV2Paths("/probe.service")).toThrow(
            "no controller-bearing ancestor"
        );
    });
});
