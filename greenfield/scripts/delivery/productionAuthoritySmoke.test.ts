import { describe, expect, test } from "bun:test";

import { rejectionError } from "../testSupport/rejection.ts";
import { runProductionAuthoritySmoke } from "./productionAuthoritySmoke.ts";

function output(value: string, exitCode = 0) {
    return Object.freeze({
        exitCode,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode(`${value}\n`),
    });
}

describe("production authority smoke", () => {
    test("requires distinct live principals, exact root fragments, and no web groups", async () => {
        const calls: string[][] = [];
        const values = new Map([
            ["mira-dashboard-web.service:User", "mira-dashboard-web"],
            ["mira-dashboard-worker.service:User", "ubuntu"],
            [
                "mira-dashboard-web.service:FragmentPath",
                "/etc/systemd/system/mira-dashboard-web.service",
            ],
            [
                "mira-dashboard-worker.service:FragmentPath",
                "/etc/systemd/system/mira-dashboard-worker.service",
            ],
            ["mira-dashboard-web.service:SupplementaryGroups", ""],
            ["mira-dashboard-worker.service:SupplementaryGroups", "docker"],
        ]);
        await runProductionAuthoritySmoke((_executable, arguments_) => {
            calls.push([...arguments_]);
            const property = arguments_[1]?.slice("--property=".length);
            const unit = arguments_[3];
            return Promise.resolve(output(values.get(`${unit}:${property}`) ?? ""));
        });
        expect(calls).toHaveLength(6);
        expect(calls.every((call) => call[0] === "show")).toBeTrue();

        const failure = await rejectionError(
            runProductionAuthoritySmoke((_executable, arguments_) => {
                const property = arguments_[1]?.slice("--property=".length);
                const unit = arguments_[3];
                const value =
                    unit === "mira-dashboard-web.service" && property === "User"
                        ? "ubuntu"
                        : (values.get(`${unit}:${property}`) ?? "");
                return Promise.resolve(output(value));
            })
        );
        expect(failure.message).toBe("Production authority smoke failed");
    });
});
