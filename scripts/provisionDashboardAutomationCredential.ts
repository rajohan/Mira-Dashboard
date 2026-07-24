import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROFILES = {
    "daily-brief": {
        fileName: "openclaw-daily-brief.token",
        id: "openclaw-daily-brief",
        scopes: ["cache:read", "reports:write", "tasks:read"],
    },
    "daily-summary": {
        fileName: "openclaw-daily-summary.token",
        id: "openclaw-daily-summary",
        scopes: ["cache:read", "reports:write"],
    },
    heartbeat: {
        fileName: "openclaw-heartbeat.token",
        id: "openclaw-heartbeat",
        scopes: ["cache:read", "reports:write"],
    },
    "task-tracking": {
        fileName: "openclaw-task-tracking.token",
        id: "openclaw-task-tracking",
        scopes: ["agents:write", "tasks:read", "tasks:write"],
    },
} as const;

type CredentialProfile = keyof typeof PROFILES;
const CREDENTIAL_PROFILE_NAMES: string[] = Object.keys(PROFILES);

function isCredentialProfile(value: string): value is CredentialProfile {
    return CREDENTIAL_PROFILE_NAMES.includes(value);
}

function usage(): string {
    return [
        "Usage:",
        "  bun scripts/provisionDashboardAutomationCredential.ts <profile>",
        "",
        `Profiles: ${Object.keys(PROFILES).join(", ")}`,
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
    if (!rawProfile || !isCredentialProfile(rawProfile) || extraArguments.length > 0) {
        throw new TypeError(usage());
    }

    const profile = PROFILES[rawProfile];
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
