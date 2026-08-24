import { afterAll, afterEach, jest } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

// Prevent test processes from inheriting a real project layout or temporary database root.
const testRoot = await mkdtemp(path.join(tmpdir(), "mira-dashboard-test-"));
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

afterAll(async () => {
    restoreEnvironment();
    await rm(testRoot, { force: true, recursive: true });
});
