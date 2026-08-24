import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { developmentProcessEnvironments } from "./developmentEnvironment.ts";
import { readDevelopmentPrivateFile } from "./developmentPrivateFile.ts";
import { resolveDevelopmentStackConfig } from "./developmentStackConfig.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");

test("validates, chmods, and reads through one no-follow file descriptor", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-dashboard-development-private-file-")
    );
    const privatePath = path.join(temporaryRoot, "private.txt");
    const symlinkPath = path.join(temporaryRoot, "private-link.txt");
    try {
        await writeFile(privatePath, "private contents\n", { mode: 0o600 });
        expect(
            await readDevelopmentPrivateFile(privatePath, {
                exactMode: 0o600,
                maximumBytes: 32,
                minimumBytes: 2,
            })
        ).toBe("private contents\n");

        await writeFile(privatePath, "x".repeat(33));
        expect(
            readDevelopmentPrivateFile(privatePath, { maximumBytes: 32 })
        ).rejects.toThrow("Development private file is invalid");
        await writeFile(privatePath, "private contents\n");

        await chmod(privatePath, 0o640);
        const invalidMode = await readDevelopmentPrivateFile(privatePath, {
            exactMode: 0o600,
        }).then(
            () => null,
            (error: unknown) => error
        );
        expect(invalidMode).toBeInstanceOf(Error);

        expect(await readDevelopmentPrivateFile(privatePath, { chmodMode: 0o600 })).toBe(
            "private contents\n"
        );
        const privateStatus = await stat(privatePath);
        expect(privateStatus.mode & 0o777).toBe(0o600);

        await symlink(privatePath, symlinkPath);
        const symlinkFailure = await readDevelopmentPrivateFile(symlinkPath).then(
            () => null,
            (error: unknown) => error
        );
        expect(symlinkFailure).toBeInstanceOf(Error);
        expect(await readFile(privatePath, "utf8")).toBe("private contents\n");
    } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
    }
});

test("reads the Gateway token from a private file without following a symlink", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-dashboard-development-gateway-token-")
    );
    const tokenPath = path.join(temporaryRoot, "gateway-token");
    const tokenSymlinkPath = path.join(temporaryRoot, "gateway-token-link");
    try {
        await writeFile(tokenPath, "private-token\n", { mode: 0o600 });
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: tokenPath,
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const environments = await developmentProcessEnvironments(
            config,
            "serialized-keyring",
            { MOLTBOOK_API_KEY: "private-moltbook-key" }
        );
        expect(environments.web.OPENCLAW_GATEWAY_TOKEN).toBe("private-token");
        expect(environments.web.MOLTBOOK_API_KEY).toBeUndefined();
        expect(environments.worker.MOLTBOOK_API_KEY).toBe("private-moltbook-key");

        const missingMoltbookKey = await developmentProcessEnvironments(
            config,
            "serialized-keyring",
            {}
        ).then(
            () => null,
            (error: unknown) => error
        );
        expect(missingMoltbookKey).toBeInstanceOf(Error);
        expect((missingMoltbookKey as Error).message).toBe(
            "Dashboard dev requires MOLTBOOK_API_KEY"
        );

        await symlink(tokenPath, tokenSymlinkPath);
        const symlinkConfig = Object.freeze({
            ...config,
            gatewayTokenFile: tokenSymlinkPath,
        });
        const failure = await developmentProcessEnvironments(
            symlinkConfig,
            "serialized-keyring",
            { MOLTBOOK_API_KEY: "private-moltbook-key" }
        ).then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("Expected token-file failure");
        expect(failure.message).toBe("Development Gateway token file is invalid");
    } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
    }
});
