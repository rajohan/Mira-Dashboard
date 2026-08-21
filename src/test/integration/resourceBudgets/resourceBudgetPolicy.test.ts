import { describe, expect, test } from "bun:test";

import {
    buildResourceBudgetLauncherCommand,
    buildResourceBudgetWorkloadCommand,
} from "./resourceBudgetCommand.ts";
import {
    assessResourceBudgetEvidence,
    createResourceBudgetUnitName,
    expectedResourceBudgetCgroupPath,
    parseResourceBudgetUnitReport,
    resourceBudgetPolicy,
    resourceBudgetScenarioIds,
    type ResourceBudgetScenarioEvidence,
} from "./resourceBudgetPolicy.ts";

const userId = 1001;
const wrapperProcessId = 4242;
const unitName = createResourceBudgetUnitName(
    "child-cancellation",
    "00000000-0000-4000-8000-000000000001"
);

function validEvidence() {
    const events = {
        high: 0,
        low: 0,
        max: 0,
        oom: 0,
        oomGroupKill: 0,
        oomKill: 0,
    };
    return {
        cgroupRemoved: true as boolean,
        launcherExitCode: 0,
        report: {
            cgroup: {
                final: {
                    cpuNrThrottled: 2,
                    cpuPressure: { fullTotalMicros: 1, someTotalMicros: 8 },
                    cpuThrottledMicros: 20,
                    cpuUsageMicros: 80_000,
                    memoryCurrentBytes: 32 * 1024 * 1024,
                    memoryEvents: { ...events },
                    memoryPressure: { fullTotalMicros: 1, someTotalMicros: 6 },
                    pidsCurrent: 1,
                },
                finalProcessIds: [wrapperProcessId],
                initial: {
                    cpuNrThrottled: 0,
                    cpuPressure: { fullTotalMicros: 0, someTotalMicros: 3 },
                    cpuThrottledMicros: 0,
                    cpuUsageMicros: 10_000,
                    memoryCurrentBytes: 24 * 1024 * 1024,
                    memoryEvents: { ...events },
                    memoryPressure: { fullTotalMicros: 0, someTotalMicros: 2 },
                    pidsCurrent: 1,
                },
                memoryPeakBytes: 64 * 1024 * 1024,
                path: expectedResourceBudgetCgroupPath(userId, unitName),
                pidsPeak: 8,
            },
            formatVersion: 1,
            limits: {
                cpuPeriodMicros: 100_000,
                cpuQuotaMicros: 100_000,
                memoryHighBytes: 192 * 1024 * 1024,
                memoryMaxBytes: 256 * 1024 * 1024,
                memorySwapMaxBytes: 0,
                oomGroup: true,
                pidsMax: 64,
            },
            runtime: {
                bunRevision: "0".repeat(40),
                bunVersion: "1.4.0",
            },
            scenarioId: "child-cancellation",
            unitName,
            workload: {
                durationMs: 1200,
                exitCode: 0,
                signalCode: null,
                stderrBytes: 0,
                stdoutBytes: 2048,
            },
            wrapperProcessId,
        },
        unitCollected: true as boolean,
    } satisfies ResourceBudgetScenarioEvidence;
}

describe("resource-budget policy", () => {
    test("freezes one reviewed explicit limit profile for every representative workload", () => {
        expect(Object.keys(resourceBudgetPolicy.scenarios).toSorted()).toEqual(
            [...resourceBudgetScenarioIds].toSorted()
        );
        expect(Object.isFrozen(resourceBudgetPolicy)).toBeTrue();
        expect(Object.isFrozen(resourceBudgetPolicy.scenarios)).toBeTrue();
        for (const scenario of Object.values(resourceBudgetPolicy.scenarios)) {
            expect(Object.isFrozen(scenario)).toBeTrue();
            expect(Object.isFrozen(scenario.limits)).toBeTrue();
            expect(scenario.limits.memoryHighBytes).toBeLessThan(
                scenario.limits.memoryMaxBytes
            );
            expect(scenario.limits.workloadDeadlineMs).toBeLessThan(
                scenario.limits.runtimeMaxSeconds * 1000
            );
            expect(scenario.limits.runtimeMaxSeconds * 1000).toBeLessThan(
                scenario.limits.outerDeadlineMs
            );
            expect(scenario.limits.memorySwapMaxBytes).toBe(0);
        }
    });

    test("builds an argv-only transient unit with no inherited application secrets", () => {
        const command = buildResourceBudgetLauncherCommand({
            bunExecutable: "/home/test/.bun/bin/bun",
            childEntrypoint:
                "/repo/src/test/integration/resourceBudgets/resourceBudgetUnit.ts",
            envExecutable: "/usr/bin/env",
            environment: {
                DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
                HOME: "/home/test",
                MIRA_SECRET: "must-not-leak",
                OPENCLAW_GATEWAY_TOKEN: "must-not-leak",
                PATH: "/untrusted/bin",
                PUBLIC_AMBIENT: "must-not-leak",
                XDG_RUNTIME_DIR: "/run/user/1001",
            },
            repositoryRoot: "/repo",
            resultPath: "/tmp/result.json",
            scenarioId: "child-cancellation",
            systemctlExecutable: "/usr/bin/systemctl",
            systemdRunExecutable: "/usr/bin/systemd-run",
            temporaryDirectory: "/tmp/workload",
            unitName,
        });

        expect(command.argv).toContain("--collect");
        expect(command.argv).toContain("--property=MemoryHigh=201326592");
        expect(command.argv).toContain("--property=MemoryMax=268435456");
        expect(command.argv).toContain("--property=MemorySwapMax=0");
        expect(command.argv).toContain("--property=TasksMax=64");
        expect(command.argv).toContain("--property=CPUQuota=100%");
        expect(command.argv).toContain("--property=OOMPolicy=kill");
        expect(command.argv).toContain("-i");
        expect(command.argv.join(" ")).not.toContain("must-not-leak");
        expect(command.environment).toEqual({
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
            HOME: "/home/test",
            PATH: "/untrusted/bin",
            XDG_RUNTIME_DIR: "/run/user/1001",
        });
    });

    test("maps every scenario to a bounded first-party integration command", () => {
        const environment = Object.freeze({ HOME: "/home/test" });
        for (const scenarioId of resourceBudgetScenarioIds) {
            const command = buildResourceBudgetWorkloadCommand(
                scenarioId,
                "/repo",
                "/home/test/.bun/bin/bun",
                environment
            );
            expect(command.argv[0]).toBe("/home/test/.bun/bin/bun");
            expect(command.argv.join(" ")).toContain("/repo/src/test/integration/");
            expect(command.environment).toBe(environment);
        }
    });

    test("accepts bounded evidence and returns host measurements without timing gates", () => {
        const evidence = validEvidence();
        expect(parseResourceBudgetUnitReport(JSON.stringify(evidence.report))).toEqual(
            evidence.report
        );
        expect(assessResourceBudgetEvidence(evidence, userId)).toEqual({
            cpuPressureMicros: 5,
            cpuThrottledMicros: 20,
            cpuUsageMicros: 70_000,
            durationMs: 1200,
            memoryHeadroomBytes: 128 * 1024 * 1024,
            memoryPeakBytes: 64 * 1024 * 1024,
            memoryPressureMicros: 4,
            pidsPeak: 8,
            scenarioId: "child-cancellation",
        });
    });

    test("rejects pressure events, cap crossings, failures, and leaked resources", () => {
        const cases: Array<
            [string, (candidate: ReturnType<typeof validEvidence>) => void]
        > = [
            [
                "memory.events oomKill",
                (candidate) => {
                    candidate.report.cgroup.final.memoryEvents.oomKill = 1;
                },
            ],
            [
                "crossed memory.high",
                (candidate) => {
                    candidate.report.cgroup.memoryPeakBytes = 192 * 1024 * 1024;
                },
            ],
            [
                "workload did not exit zero",
                (candidate) => {
                    candidate.report.workload.exitCode = 1;
                },
            ],
            [
                "leaked processes",
                (candidate) => {
                    candidate.report.cgroup.finalProcessIds.push(9999);
                },
            ],
            [
                "cgroup was not removed",
                (candidate) => {
                    candidate.cgroupRemoved = false;
                },
            ],
            [
                "unit was not collected",
                (candidate) => {
                    candidate.unitCollected = false;
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            const candidate = structuredClone(validEvidence());
            mutate(candidate);
            expect(() => assessResourceBudgetEvidence(candidate, userId)).toThrow(
                message
            );
        }
    });

    test("rejects malformed reports and attacker-controlled unit names", () => {
        expect(() =>
            parseResourceBudgetUnitReport(
                JSON.stringify({ ...validEvidence().report, unexpected: true })
            )
        ).toThrow();
        expect(() =>
            createResourceBudgetUnitName("child-cancellation", "../attacker")
        ).toThrow("unit identifier");
    });
});
