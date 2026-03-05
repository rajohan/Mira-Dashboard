import { execSync } from "node:child_process";
import express, { type RequestHandler } from "express";

export interface VersionResponse {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checkedAt: number;
}

function runCommand(command: string): string | null {
    try {
        return execSync(command, {
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
            timeout: 8000,
        }).trim();
    } catch {
        return null;
    }
}

function runFirst(commands: string[]): string | null {
    for (const command of commands) {
        const value = runCommand(command);
        if (value) {
            return value;
        }
    }

    return null;
}

function normalizeVersion(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const match = value.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] || value;
}

export async function fetchOpenClawVersion(): Promise<VersionResponse> {
    const currentRaw = runFirst([
        "openclaw --version",
        "/home/ubuntu/.npm-global/bin/openclaw --version",
    ]);
    const latestRaw = runFirst([
        "npm view openclaw version",
        "/usr/bin/npm view openclaw version",
    ]);

    const current = normalizeVersion(currentRaw) || "unknown";
    const latest = normalizeVersion(latestRaw);

    return {
        current,
        latest,
        updateAvailable: current !== "unknown" && latest !== null && current !== latest,
        checkedAt: Date.now(),
    };
}

export default function openclawRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.get("/api/openclaw/version", (async (_req, res) => {
        const version = await fetchOpenClawVersion();
        res.json(version);
    }) as RequestHandler);
}
