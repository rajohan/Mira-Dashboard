import { describe, expect, test } from "bun:test";

import { rejectionError } from "../testSupport/rejection.ts";
import {
    parsePrepareProductionStateCliArguments,
    runPrepareProductionStateCli,
} from "./prepareProductionState.ts";
import type { PreparedProductionStatePaths } from "./productionStateFilesystem.ts";

const projectRoot = "/srv/mira-dashboard";

function preparedPaths(root: string): PreparedProductionStatePaths {
    return {
        backupsDirectory: `${root}/production/state/backups`,
        jobOutputDirectory: `${root}/production/state/job-output`,
        logsDirectory: `${root}/production/state/logs`,
        productionDirectory: `${root}/production`,
        projectRoot: root,
        stateDirectory: `${root}/production/state`,
    };
}

describe("production state preparation CLI", () => {
    test("accepts exactly one canonical absolute project root", () => {
        expect(
            parsePrepareProductionStateCliArguments([`--project-root=${projectRoot}`])
        ).toEqual({ projectRoot });

        for (const arguments_ of [
            [],
            [`--project-root=${projectRoot}`, "--extra"],
            ["--project-root=relative"],
            ["--project-root=/"],
            [`--project-root=${projectRoot}/..`],
            ["--other=/srv/mira-dashboard"],
        ]) {
            expect(() => parsePrepareProductionStateCliArguments(arguments_)).toThrow(
                "Usage:"
            );
        }
    });

    test("invokes the repair boundary once and returns only fixed status metadata", async () => {
        const observedRoots: string[] = [];

        const result = await runPrepareProductionStateCli(
            [`--project-root=${projectRoot}`],
            (root) => {
                observedRoots.push(root);
                return Promise.resolve(preparedPaths(root));
            }
        );

        expect(observedRoots).toEqual([projectRoot]);
        expect(result).toEqual({ status: "PREPARED" });
        expect(Object.isFrozen(result)).toBe(true);
    });

    test("propagates state-policy failures without retrying", async () => {
        const failure = new Error("state rejected");
        let calls = 0;

        const observedFailure = await rejectionError(
            runPrepareProductionStateCli([`--project-root=${projectRoot}`], () => {
                calls += 1;
                return Promise.reject(failure);
            })
        );
        expect(observedFailure).toBe(failure);
        expect(calls).toBe(1);
    });
});
