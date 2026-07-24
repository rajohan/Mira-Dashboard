import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    DASHBOARD_AUTOMATION_PROFILE_NAMES,
    DASHBOARD_AUTOMATION_PROFILES,
    isDashboardAutomationProfile,
} from "./dashboardAutomationProfiles.ts";

function usage(): string {
    return [
        "Usage:",
        "  bun scripts/provisionDashboardAutomationCredential.ts <profile>",
        "",
        `Profiles: ${DASHBOARD_AUTOMATION_PROFILE_NAMES.join(", ")}`,
        "",
        "The full bearer token is written directly to its 0600 client file.",
        "Only the hash-only Dashboard configuration entry is printed.",
    ].join("\n");
}

function credentialDirectory(): string {
    return path.join(os.homedir(), ".config", "mira-dashboard", "automation");
}

async function ensureCredentialDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Credential path is not a regular directory: ${directory}`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
        throw new Error(`Credential directory permissions must be 0700: ${directory}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("Credential directory must be owned by the current user");
    }
}

async function main(arguments_: string[]): Promise<void> {
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
        console.log(usage());
        return;
    }
    const [rawProfile, ...extraArguments] = arguments_;
    if (
        !rawProfile ||
        !isDashboardAutomationProfile(rawProfile) ||
        extraArguments.length > 0
    ) {
        throw new TypeError(usage());
    }

    const profile = DASHBOARD_AUTOMATION_PROFILES[rawProfile];
    const directory = credentialDirectory();
    await ensureCredentialDirectory(directory);

    const validator = crypto.getRandomValues(new Uint8Array(32)).toHex();
    const tokenPath = path.join(directory, profile.fileName);
    await writeFile(tokenPath, `${profile.id}.${validator}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
    });
    await chmod(tokenPath, 0o600);
    const stat = await lstat(tokenPath);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
        throw new Error("Credential file failed its ownership or mode check");
    }

    const tokenHash = new Bun.CryptoHasher("sha256").update(validator).digest("hex");
    console.error(`Credential written to ${tokenPath}`);
    console.log(
        JSON.stringify(
            {
                id: profile.id,
                scopes: profile.scopes,
                tokenHash,
            },
            undefined,
            2
        )
    );
}

if (import.meta.main) {
    try {
        await main(Bun.argv.slice(2));
    } catch (error) {
        console.error(
            error instanceof Error
                ? error.message
                : "Dashboard credential provisioning failed"
        );
        process.exitCode = 1;
    }
}
