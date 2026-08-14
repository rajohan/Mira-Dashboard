import { afterEach, jest } from "bun:test";
import { rmSync } from "node:fs";
import { chmod, lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const testRootParentEnvironmentName = "MIRA_DASHBOARD_TEST_ROOT_PARENT";
const managedEnvironmentNames = Object.freeze([
    "MIRA_DASHBOARD_PROJECT_ROOT",
    "NODE_ENV",
    "TEMP",
    "TMP",
    "TMPDIR",
] as const);
const originalEnvironment = new Map(
    managedEnvironmentNames.map((name) => [name, process.env[name]] as const)
);

async function resolveTestRootParent(): Promise<string> {
    const configuredParent = process.env[testRootParentEnvironmentName];
    if (configuredParent === undefined) return tmpdir();
    if (
        configuredParent.length === 0 ||
        configuredParent.trim() !== configuredParent ||
        !path.isAbsolute(configuredParent) ||
        path.dirname(configuredParent) !== path.resolve(tmpdir())
    ) {
        throw new TypeError("Test root parent must be an absolute child of TMPDIR");
    }

    const status = await lstat(configuredParent);
    if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new TypeError("Test root parent must be a real directory");
    }
    if ((status.mode & 0o777) !== 0o700) {
        throw new TypeError("Test root parent must have mode 0700");
    }
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
        throw new TypeError("Test root parent must belong to the test user");
    }
    return configuredParent;
}

// Prevent test processes from inheriting a real project layout or temporary database root.
const testRootParent = await resolveTestRootParent();
const testRoot = await mkdtemp(path.join(testRootParent, "mira-dashboard-test-"));
await chmod(testRoot, 0o700);

process.env.NODE_ENV = "test";
process.env.MIRA_DASHBOARD_PROJECT_ROOT = testRoot;
process.env.TEMP = testRoot;
process.env.TMP = testRoot;
process.env.TMPDIR = testRoot;

function restoreEnvironment(): void {
    for (const name of managedEnvironmentNames) {
        const value = originalEnvironment.get(name);
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
}

afterEach(() => {
    jest.restoreAllMocks();
});

process.once("exit", () => {
    restoreEnvironment();
    rmSync(testRoot, { force: true, recursive: true });
});
