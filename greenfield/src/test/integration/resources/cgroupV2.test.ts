import { describe, expect, test } from "bun:test";

import {
    type CgroupV2FileContents,
    parseCgroupV2Snapshot,
    readCgroupV2ControlFile,
} from "./cgroupV2.ts";

function fileContents(
    overrides: Partial<CgroupV2FileContents> = {}
): CgroupV2FileContents {
    return {
        cpuMax: "50000 100000\n",
        memoryCurrent: "1048576\n",
        memoryEvents: "low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\noom_group_kill 5\n",
        memoryHigh: "268435456\n",
        memoryMax: "402653184\n",
        memoryOomGroup: "1\n",
        memoryPeak: "2097152\n",
        memorySwapMax: "0\n",
        pidsCurrent: "4\n",
        pidsMax: "32\n",
        selfCgroup:
            "0::/user.slice/user-1001.slice/user@1001.service/app.slice/probe.service\n",
        ...overrides,
    };
}

describe("cgroup v2 snapshot parsing", () => {
    test("parses and freezes a complete unified-controller snapshot", () => {
        const snapshot = parseCgroupV2Snapshot(fileContents());

        expect(snapshot).toEqual({
            cpuPeriodMicros: 100_000,
            cpuQuotaMicros: 50_000,
            memoryCurrentBytes: 1_048_576,
            memoryEvents: {
                high: 1,
                low: 0,
                max: 2,
                oom: 3,
                oomGroupKill: 5,
                oomKill: 4,
            },
            memoryHighBytes: 268_435_456,
            memoryMaxBytes: 402_653_184,
            memoryPeakBytes: 2_097_152,
            memorySwapMaxBytes: 0,
            oomGroup: true,
            path: "/user.slice/user-1001.slice/user@1001.service/app.slice/probe.service",
            pidsCurrent: 4,
            pidsMax: 32,
        });
        expect(Object.isFrozen(snapshot)).toBeTrue();
        expect(Object.isFrozen(snapshot.memoryEvents)).toBeTrue();
    });

    test("preserves valid unbounded controller values", () => {
        const snapshot = parseCgroupV2Snapshot(
            fileContents({
                cpuMax: "max 100000",
                memoryHigh: "max",
                memoryMax: "max",
                memorySwapMax: "max",
                pidsMax: "max",
            })
        );

        expect(snapshot.cpuQuotaMicros).toBe("max");
        expect(snapshot.memoryHighBytes).toBe("max");
        expect(snapshot.memoryMaxBytes).toBe("max");
        expect(snapshot.memorySwapMaxBytes).toBe("max");
        expect(snapshot.pidsMax).toBe("max");
    });

    test("preserves accepted decimal strings with leading zeroes", () => {
        const snapshot = parseCgroupV2Snapshot(
            fileContents({ memoryCurrent: "0001048576\n" })
        );

        expect(snapshot.memoryCurrentBytes).toBe(1_048_576);
    });

    test("rejects non-unified and unsafe process membership paths", () => {
        for (const selfCgroup of [
            "2:cpu:/legacy\n0::/unified",
            "0::/user.slice/../escape",
            "0::relative",
            "",
        ]) {
            expect(() => parseCgroupV2Snapshot(fileContents({ selfCgroup }))).toThrow(
                "Invalid cgroup v2 process membership"
            );
        }
    });

    test("rejects malformed numeric and binary controller values", () => {
        const invalidFiles: Array<Partial<CgroupV2FileContents>> = [
            { memoryCurrent: "-1" },
            { memoryCurrent: String(Number.MAX_SAFE_INTEGER + 1) },
            { memoryPeak: "1.5" },
            { memoryHigh: "unlimited" },
            { pidsCurrent: "NaN" },
            { cpuMax: "0 100000" },
            { cpuMax: "50000 0" },
            { cpuMax: "50000" },
            { memoryOomGroup: "yes" },
        ];

        for (const overrides of invalidFiles) {
            expect(() => parseCgroupV2Snapshot(fileContents(overrides))).toThrow(
                "Invalid cgroup v2"
            );
        }
    });

    test("requires each memory event exactly once and tolerates future counters", () => {
        expect(() =>
            parseCgroupV2Snapshot(
                fileContents({
                    memoryEvents:
                        "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_kill 0\noom_group_kill 0",
                })
            )
        ).toThrow("duplicate oom_kill");
        expect(() =>
            parseCgroupV2Snapshot(
                fileContents({
                    memoryEvents: "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0",
                })
            )
        ).toThrow("missing oom_group_kill");

        const snapshot = parseCgroupV2Snapshot(
            fileContents({
                memoryEvents:
                    "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\nfuture_counter 9",
            })
        );
        expect(snapshot.memoryEvents.oomGroupKill).toBe(0);
    });

    test("identifies the controller and membership path when reads fail", async () => {
        const missingPath = `/mira-dashboard-missing-${Bun.randomUUIDv7()}`;
        const failure = await readCgroupV2ControlFile(missingPath, "memory.max").then(
            () => null,
            (error: unknown) => error
        );

        if (!(failure instanceof Error)) {
            throw new Error("Expected the missing cgroup controller read to fail");
        }
        expect(failure.message).toBe(
            `Could not read cgroup v2 control file memory.max for ${missingPath}`
        );
    });
});
