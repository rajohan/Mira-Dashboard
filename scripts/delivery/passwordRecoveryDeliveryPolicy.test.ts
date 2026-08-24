import { describe, expect, test } from "bun:test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const expectedCommand =
    "/usr/bin/env -i NODE_ENV=production /home/ubuntu/projects/mira-dashboard/production/runtimes/bun/current/bun /home/ubuntu/projects/mira-dashboard/production/releases/current/server/resetDashboardPassword.js --project-root=/home/ubuntu/projects/mira-dashboard";

describe("Dashboard host password-recovery delivery policy", () => {
    test("invokes only the pinned production runtime and active immutable release", async () => {
        const packageValue = (await Bun.file(
            path.join(repositoryRoot, "package.json")
        ).json()) as { readonly scripts?: Readonly<Record<string, string>> };

        expect(packageValue.scripts?.["auth:reset-password"]).toBe(expectedCommand);
        expect(expectedCommand).not.toContain("doppler");
        expect(expectedCommand).not.toContain("src/app");
    });
});
