import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    DASHBOARD_AUTOMATION_PROFILE_NAMES,
    DASHBOARD_AUTOMATION_PROFILES,
    type DashboardAutomationProfile,
    isDashboardAutomationProfile,
} from "./dashboardAutomationProfiles.ts";

const DASHBOARD_ORIGIN = "http://127.0.0.1:3100";
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.[a-f0-9]{64}$/u;
const ALLOWED_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);

function usage(): string {
    return [
        "Usage:",
        "  bun scripts/miraDashboardApi.ts <profile> <method> <api-path>",
        "",
        `Profiles: ${DASHBOARD_AUTOMATION_PROFILE_NAMES.join(", ")}`,
        "Request bodies are read from stdin and never from command-line arguments.",
        "",
        "Examples:",
        "  bun scripts/miraDashboardApi.ts heartbeat GET /api/cache/heartbeat",
        "  printf '%s' '{\"currentTask\":\"Work\"}' | \\",
        "    bun scripts/miraDashboardApi.ts task-tracking PUT /api/agents/main/metadata",
    ].join("\n");
}

function credentialFile(profile: DashboardAutomationProfile): string {
    return path.join(
        os.homedir(),
        ".config",
        "mira-dashboard",
        "automation",
        DASHBOARD_AUTOMATION_PROFILES[profile].fileName
    );
}

async function readCredential(profile: DashboardAutomationProfile): Promise<string> {
    const tokenPath = credentialFile(profile);
    const file = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile()) {
            throw new Error(`Credential is not a regular file: ${tokenPath}`);
        }
        if ((stat.mode & 0o777) !== 0o600) {
            throw new Error(`Credential permissions must be 0600: ${tokenPath}`);
        }
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
            throw new Error(`Credential must be owned by the current user: ${tokenPath}`);
        }
        if (stat.size > 256) {
            throw new Error(`Credential file is unexpectedly large: ${tokenPath}`);
        }
        const tokenContents = await file.readFile({ encoding: "utf8" });
        const token = tokenContents.trim();
        if (!TOKEN_PATTERN.test(token)) {
            throw new Error(`Credential has an invalid format: ${tokenPath}`);
        }
        return token;
    } finally {
        await file.close();
    }
}

function requestUrl(apiPath: string): URL {
    if (!apiPath.startsWith("/api/") || apiPath.includes("\0") || apiPath.includes("#")) {
        throw new TypeError(
            "api-path must start with /api/ and cannot contain a fragment"
        );
    }
    const url = new URL(apiPath, DASHBOARD_ORIGIN);
    if (url.origin !== DASHBOARD_ORIGIN || !url.pathname.startsWith("/api/")) {
        throw new TypeError("api-path must remain within the local Dashboard API");
    }
    return url;
}

async function stdinBody(method: string): Promise<string | undefined> {
    if (method === "GET" || method === "HEAD") {
        return undefined;
    }
    const body = await new Response(Bun.stdin.stream()).text();
    return body.length > 0 ? body : undefined;
}

async function main(arguments_: string[]): Promise<void> {
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
        console.log(usage());
        return;
    }
    const [rawProfile, rawMethod, rawApiPath, ...extraArguments] = arguments_;
    if (
        !rawProfile ||
        !rawMethod ||
        !rawApiPath ||
        extraArguments.length > 0 ||
        !isDashboardAutomationProfile(rawProfile)
    ) {
        throw new TypeError(usage());
    }
    const profile = rawProfile;
    const method = rawMethod.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
        throw new TypeError(`Unsupported HTTP method: ${rawMethod}`);
    }

    const body = await stdinBody(method);
    const token = await readCredential(profile);
    const response = await fetch(requestUrl(rawApiPath), {
        body,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseBody = await response.text();
    if (!response.ok) {
        throw new Error(
            `Dashboard API returned HTTP ${response.status}${
                responseBody.trim() ? `: ${responseBody.trim().slice(0, 500)}` : ""
            }`
        );
    }
    process.stdout.write(responseBody);
}

if (import.meta.main) {
    try {
        await main(Bun.argv.slice(2));
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : "Dashboard API call failed"
        );
        process.exitCode = 1;
    }
}
