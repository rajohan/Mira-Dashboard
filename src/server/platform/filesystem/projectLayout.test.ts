import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    deriveDashboardProjectLayout,
    resolveDashboardProjectLayout,
} from "./projectLayout.ts";

const temporaryRoots: string[] = [];

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("Expected the promise to reject");
}

afterEach(async () => {
    await Promise.all(
        temporaryRoots
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function temporaryProjectRoot(): Promise<string> {
    const parent = await mkdtemp(path.join(tmpdir(), "mira-project-layout-"));
    temporaryRoots.push(parent);
    const root = path.join(parent, "dashboard");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    return root;
}

describe("Dashboard project layout", () => {
    test("derives every persistent path beneath development or production", async () => {
        const root = await temporaryProjectRoot();
        const layout = await resolveDashboardProjectLayout(root);

        expect(layout).toEqual(deriveDashboardProjectLayout(root));
        expect(layout.production.state.root).toBe(path.join(root, "production/state"));
        expect(layout.production.state.logs).toBe(
            path.join(root, "production/state/logs")
        );
        expect(layout.production.state.backups).toBe(
            path.join(root, "production/state/backups")
        );
        expect(layout.production.state.jobOutput).toBe(
            path.join(root, "production/state/job-output")
        );
        expect(layout.production.state.logMaintenance).toBe(
            path.join(root, "production/state/log-maintenance")
        );
        expect(layout.production.state.terminalBroker).toBe(
            path.join(root, "production/state/terminal-broker")
        );
        expect(layout.production.state.terminalBrokerSocket).toBe(
            path.join(root, "production/state/terminal-broker/terminal.sock")
        );
        expect(layout.production.state.workspaceFileUploads).toBe(
            path.join(root, "production/state/workspace-file-uploads")
        );
        expect(layout.development.worktrees).toBe(
            path.join(root, "development/worktrees")
        );
        expect(Object.isFrozen(layout.production.state)).toBe(true);
    });

    test("rejects relative, root, NUL-tainted and non-normalized candidates", () => {
        for (const candidate of [
            ".",
            path.parse(process.cwd()).root,
            `${process.cwd()}\0escape`,
            `${process.cwd()}/nested/..`,
        ]) {
            expect(() => deriveDashboardProjectLayout(candidate)).toThrow(
                "Dashboard project root is invalid"
            );
        }
    });

    test("rejects a symlinked project-root entry", async () => {
        const target = await temporaryProjectRoot();
        const link = path.join(path.dirname(target), "dashboard-link");
        await symlink(target, link, "dir");

        expect(await rejectionOf(resolveDashboardProjectLayout(link))).toMatchObject({
            message: "Dashboard project root is invalid",
        });
    });

    test("rejects a writable project root or non-sticky ancestor", async () => {
        const root = await temporaryProjectRoot();
        const parent = path.dirname(root);

        await chmod(root, 0o770);
        expect(await rejectionOf(resolveDashboardProjectLayout(root))).toBeInstanceOf(
            TypeError
        );

        await chmod(root, 0o700);
        await chmod(parent, 0o770);
        expect(await rejectionOf(resolveDashboardProjectLayout(root))).toBeInstanceOf(
            TypeError
        );
    });
});
