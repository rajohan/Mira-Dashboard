import { describe, expect, test } from "bun:test";
import Fs from "node:fs";

import { Redacted } from "effect";

import {
    createDashboardMainGitSync,
    type DeliveryMainGitProcess,
    type DeliveryMainGitProcessRequest,
} from "./dashboardMainGitSync.ts";

const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);

function credentials() {
    return {
        password: Redacted.make("github_pat_test_value_long_enough", {
            label: "test-password",
        }),
        username: Redacted.make("mira-2026", { label: "test-username" }),
    };
}

function output(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

describe("Delivery production main Git sync", () => {
    test("uses fixed scrubbed Git commands and fast-forwards to the authenticated exact ref", () => {
        const root = Fs.mkdtempSync("/tmp/mira-delivery-git-");
        const calls: DeliveryMainGitProcessRequest[] = [];
        let head = oldHead;
        const process: DeliveryMainGitProcess = (request) => {
            calls.push(request);
            const arguments_ = request.arguments;
            const commandIndex = arguments_.findIndex((value) =>
                [
                    "fetch",
                    "ls-remote",
                    "merge",
                    "remote",
                    "rev-parse",
                    "status",
                    "symbolic-ref",
                ].includes(value)
            );
            const command = arguments_[commandIndex];
            const tail = arguments_.slice(commandIndex + 1);
            let stdout = "";
            if (command === "rev-parse" && tail[0] === "--show-toplevel") stdout = root;
            else if (command === "rev-parse" && tail.includes("@{upstream}"))
                stdout = "origin/main";
            else if (command === "symbolic-ref") stdout = "refs/heads/main";
            else if (
                command === "rev-parse" &&
                tail[1] === "refs/remotes/origin/main^{commit}"
            )
                stdout = newHead;
            else if (command === "rev-parse") stdout = head;
            else if (command === "remote")
                stdout = "https://github.com/rajohan/Mira-Dashboard.git";
            else if (command === "status") stdout = "";
            else if (command === "ls-remote") stdout = `${newHead}\trefs/heads/main\n`;
            else if (command === "merge") head = newHead;
            return Promise.resolve({
                exitCode: 0,
                stderr: output(""),
                stdout: output(stdout),
            });
        };
        const sync = createDashboardMainGitSync({
            allowLocalCheckoutForTests: true,
            checkoutRoot: root,
            credentials: credentials(),
            process,
        });

        expect(sync.syncMainToExactRef(newHead, oldHead)).resolves.toEqual({
            headSha: newHead,
            outcome: "completed",
        });
        expect(calls.every(({ executable }) => executable === "/usr/bin/git")).toBeTrue();
        expect(
            calls.every(({ environment }) => environment.HOME === "/nonexistent")
        ).toBeTrue();
        expect(
            calls.every(
                ({ environment }) => environment.GIT_CONFIG_GLOBAL === "/dev/null"
            )
        ).toBeTrue();
        expect(
            calls.some(({ arguments: values }) => values.includes("--ff-only"))
        ).toBeTrue();
        expect(
            calls.some(({ arguments: values }) => values.includes("pull"))
        ).toBeFalse();
        expect(
            calls.some(({ arguments: values }) => values.includes("reset"))
        ).toBeFalse();
    });

    test("fails closed before mutation for a dirty or stale checkout", () => {
        const root = Fs.mkdtempSync("/tmp/mira-delivery-git-");
        const commands: string[] = [];
        const sync = createDashboardMainGitSync({
            allowLocalCheckoutForTests: true,
            checkoutRoot: root,
            credentials: credentials(),
            process: (request) => {
                const command = request.arguments.find((value) =>
                    [
                        "fetch",
                        "ls-remote",
                        "merge",
                        "remote",
                        "rev-parse",
                        "status",
                        "symbolic-ref",
                    ].includes(value)
                );
                commands.push(command ?? "");
                let stdout = "";
                if (
                    command === "rev-parse" &&
                    request.arguments.includes("--show-toplevel")
                )
                    stdout = root;
                else if (
                    command === "rev-parse" &&
                    request.arguments.includes("@{upstream}")
                )
                    stdout = "origin/main";
                else if (command === "symbolic-ref") stdout = "refs/heads/main";
                else if (command === "rev-parse") stdout = oldHead;
                else if (command === "remote")
                    stdout = "https://github.com/rajohan/Mira-Dashboard.git";
                else if (command === "status") stdout = " M src/index.ts\n";
                return Promise.resolve({
                    exitCode: 0,
                    stderr: output(""),
                    stdout: output(stdout),
                });
            },
        });

        expect(sync.inspect()).resolves.toMatchObject({
            branch: "main",
            condition: "dirty",
            headSha: oldHead,
            safe: false,
            upstream: "origin/main",
        });
        expect(sync.syncMainToExactRef(newHead, oldHead)).rejects.toThrow();
        expect(commands).not.toContain("fetch");
        expect(commands).not.toContain("merge");
    });
});
