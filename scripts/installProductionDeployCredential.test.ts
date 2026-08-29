import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installProductionDeployCredential } from "./installProductionDeployCredential.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await chmod(directory, 0o700).catch(() => {});
        await rm(directory, { force: true, recursive: true });
    }
});

describe("production deploy credential installer", () => {
    test("atomically installs one owner-private credential without echoing it", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-deploy-credential-"));
        temporaryDirectories.push(root);
        const directory = path.join(root, "automation");
        const token = `${"a".repeat(32)}.${"b".repeat(64)}`;
        const output: string[] = [];

        await installProductionDeployCredential({
            directory,
            readInput: () => Promise.resolve(`  ${token}\n`),
            writeOutput: (message) => output.push(message),
        });
        const directoryStatus = await lstat(directory);
        const credentialStatus = await lstat(
            path.join(directory, "delivery-deploy.token")
        );

        expect(
            await readFile(path.join(directory, "delivery-deploy.token"), "utf8")
        ).toBe(`${token}\n`);
        expect(directoryStatus.mode & 0o777).toBe(0o700);
        expect(credentialStatus.mode & 0o777).toBe(0o600);
        expect(output).toEqual(["Installed production deploy credential\n"]);
        expect(output.join("")).not.toContain(token);
    });

    test("rejects invalid input before creating the credential directory", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-deploy-credential-"));
        temporaryDirectories.push(root);
        const directory = path.join(root, "automation");

        expect(
            installProductionDeployCredential({
                directory,
                readInput: () => Promise.resolve("invalid"),
                writeOutput: () => {},
            })
        ).rejects.toThrow("Production deploy credential installation failed");
        expect(Bun.file(directory).exists()).resolves.toBeFalse();
    });
});
