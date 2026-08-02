import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    type ManagedDashboardSystemdCommandRunner,
    prepareManagedDashboardUnits,
} from "../src/services/releases/systemd.ts";
import { loadManagedRelease, managedReleasePath } from "../src/services/releases/manager.ts";
import { MANAGED_DASHBOARD_UNIT_NAMES } from "../src/services/releases/systemdPolicy.ts";
import { captureRejection } from "./support/rejections.ts";
import { createReleaseFixture } from "./support/releaseFixture.ts";

const COMMIT_SHA = "a".repeat(40);
const temporaryRoots: string[] = [];
const rejectUnexpectedSystemctl: ManagedDashboardSystemdCommandRunner = () => {
    throw new Error("systemctl must not run for an incomplete bundle");
};

function temporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
}

async function managedReleaseWithUnits(releasesRoot: string) {
    const releasePath = managedReleasePath(releasesRoot, COMMIT_SHA);
    mkdirSync(path.join(releasePath, "systemd"), { recursive: true });
    for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
        writeFileSync(
            path.join(releasePath, "systemd", unit),
            `[Unit]\nDescription=${unit}\n[Service]\nExecStart=/${unit}\n`
        );
    }
    await createReleaseFixture(releasePath, COMMIT_SHA);
    return loadManagedRelease(releasesRoot, COMMIT_SHA);
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

describe("managed Dashboard systemd reconciliation", () => {
    it("atomically installs and verifies the target release unit bundle", async () => {
        const releasesRoot = temporaryRoot("mira-systemd-release-");
        const unitRoot = path.join(temporaryRoot("mira-systemd-user-"), "units");
        const release = await managedReleaseWithUnits(releasesRoot);
        const calls: Array<[string, readonly string[]]> = [];
        const commandRunner: ManagedDashboardSystemdCommandRunner = (
            command,
            arguments_
        ) => {
            calls.push([command, arguments_]);
            const unit = MANAGED_DASHBOARD_UNIT_NAMES.find((candidate) =>
                arguments_.includes(candidate)
            );
            return Promise.resolve({
                stderr: "",
                stdout: unit
                    ? `DropInPaths=\nFragmentPath=${path.join(
                          unitRoot,
                          unit
                      )}\nLoadState=loaded\n`
                    : "",
            });
        };

        expect(
            await prepareManagedDashboardUnits(release, { commandRunner, unitRoot })
        ).toMatchObject({
            changed: [...MANAGED_DASHBOARD_UNIT_NAMES],
        });
        for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
            expect(readFileSync(path.join(unitRoot, unit), "utf8")).toBe(
                readFileSync(path.join(release.path, "systemd", unit), "utf8")
            );
            expect(statSync(path.join(unitRoot, unit)).mode & 0o777).toBe(0o644);
        }
        expect(calls).toHaveLength(MANAGED_DASHBOARD_UNIT_NAMES.length + 1);

        calls.length = 0;
        expect(
            await prepareManagedDashboardUnits(release, { commandRunner, unitRoot })
        ).toMatchObject({
            changed: [],
        });
        expect(calls).toHaveLength(MANAGED_DASHBOARD_UNIT_NAMES.length + 1);
    });

    it("repairs unit modes even when the managed content already matches", async () => {
        const releasesRoot = temporaryRoot("mira-systemd-mode-release-");
        const unitRoot = path.join(temporaryRoot("mira-systemd-mode-user-"), "units");
        const release = await managedReleaseWithUnits(releasesRoot);
        mkdirSync(unitRoot, { recursive: true });
        for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
            writeFileSync(
                path.join(unitRoot, unit),
                readFileSync(path.join(release.path, "systemd", unit), "utf8"),
                { mode: 0o600 }
            );
        }
        const commandRunner: ManagedDashboardSystemdCommandRunner = (
            _command,
            arguments_
        ) => {
            const unit = MANAGED_DASHBOARD_UNIT_NAMES.find((candidate) =>
                arguments_.includes(candidate)
            );
            return Promise.resolve({
                stderr: "",
                stdout: unit
                    ? `DropInPaths=\nFragmentPath=${path.join(
                          unitRoot,
                          unit
                      )}\nLoadState=loaded\n`
                    : "",
            });
        };

        expect(
            await prepareManagedDashboardUnits(release, { commandRunner, unitRoot })
        ).toMatchObject({
            changed: [...MANAGED_DASHBOARD_UNIT_NAMES],
        });
        for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
            expect(statSync(path.join(unitRoot, unit)).mode & 0o777).toBe(0o644);
        }
    });

    it("restores the installed units when daemon verification fails", async () => {
        const releasesRoot = temporaryRoot("mira-systemd-rollback-release-");
        const unitRoot = path.join(temporaryRoot("mira-systemd-rollback-user-"), "units");
        const release = await managedReleaseWithUnits(releasesRoot);
        mkdirSync(unitRoot, { recursive: true });
        for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
            writeFileSync(path.join(unitRoot, unit), `old ${unit}\n`);
            chmodSync(path.join(unitRoot, unit), 0o644);
        }
        chmodSync(path.join(unitRoot, MANAGED_DASHBOARD_UNIT_NAMES[0]!), 0o600);
        let reloads = 0;
        const commandRunner: ManagedDashboardSystemdCommandRunner = (
            _command,
            arguments_
        ) => {
            if (arguments_.includes("daemon-reload")) {
                reloads += 1;
                return Promise.resolve({ stderr: "", stdout: "" });
            }
            return Promise.resolve({
                stderr: "",
                stdout: "FragmentPath=/wrong/path\nLoadState=loaded\n",
            });
        };

        const reconcileError = await captureRejection(() =>
            prepareManagedDashboardUnits(release, { commandRunner, unitRoot })
        );
        expect(reconcileError).toBeInstanceOf(Error);
        expect((reconcileError as Error).message).toContain(
            "did not load exclusively from its managed unit path"
        );
        expect(reloads).toBe(2);
        for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
            expect(readFileSync(path.join(unitRoot, unit), "utf8")).toBe(`old ${unit}\n`);
        }
        expect(
            statSync(path.join(unitRoot, MANAGED_DASHBOARD_UNIT_NAMES[0]!)).mode & 0o777
        ).toBe(0o600);
    });

    it("restores the installed units when the release transition fails", async () => {
        const releasesRoot = temporaryRoot("mira-systemd-transition-release-");
        const unitRoot = path.join(
            temporaryRoot("mira-systemd-transition-user-"),
            "units"
        );
        const release = await managedReleaseWithUnits(releasesRoot);
        mkdirSync(unitRoot, { recursive: true });
        const existingUnit = MANAGED_DASHBOARD_UNIT_NAMES[0]!;
        const newlyInstalledUnit = MANAGED_DASHBOARD_UNIT_NAMES[1]!;
        writeFileSync(path.join(unitRoot, existingUnit), `old ${existingUnit}\n`);
        let reloads = 0;
        const commandRunner: ManagedDashboardSystemdCommandRunner = (
            _command,
            arguments_
        ) => {
            if (arguments_.includes("daemon-reload")) {
                reloads += 1;
                return Promise.resolve({ stderr: "", stdout: "" });
            }
            const unit = MANAGED_DASHBOARD_UNIT_NAMES.find((candidate) =>
                arguments_.includes(candidate)
            );
            return Promise.resolve({
                stderr: "",
                stdout: unit
                    ? `DropInPaths=\nFragmentPath=${path.join(
                          unitRoot,
                          unit
                      )}\nLoadState=loaded\n`
                    : "",
            });
        };
        const prepared = await prepareManagedDashboardUnits(release, {
            commandRunner,
            unitRoot,
        });
        await prepared.rollback();
        expect(reloads).toBe(2);
        expect(readFileSync(path.join(unitRoot, existingUnit), "utf8")).toBe(
            `old ${existingUnit}\n`
        );
        expect(existsSync(path.join(unitRoot, newlyInstalledUnit))).toBe(false);
    });

    it("rejects releases that predate the managed unit bundle", async () => {
        const releasesRoot = temporaryRoot("mira-systemd-legacy-release-");
        const releasePath = managedReleasePath(releasesRoot, COMMIT_SHA);
        mkdirSync(releasePath, { recursive: true });
        await createReleaseFixture(releasePath, COMMIT_SHA);
        const release = await loadManagedRelease(releasesRoot, COMMIT_SHA);
        const unitRoot = path.join(temporaryRoot("mira-systemd-legacy-user-"), "units");
        const bundleError = await captureRejection(() =>
            prepareManagedDashboardUnits(release, {
                commandRunner: rejectUnexpectedSystemctl,
                unitRoot,
            })
        );
        expect(bundleError).toBeInstanceOf(Error);
        expect((bundleError as Error).message).toContain(
            "does not contain managed systemd units"
        );
        expect(existsSync(unitRoot)).toBe(false);
    });
});
