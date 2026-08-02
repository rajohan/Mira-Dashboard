import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hasLineBreakOrNullByte } from "../../lib/values.ts";
import { ensureRealDirectory, isRealRegularFile } from "./fileSystem.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

const MAX_GATEWAY_TOKEN_BYTES = 16 * 1024;

function materializeGatewayTokenFile(
    filePath: string,
    tokenValue: string | undefined,
    label: string
): void {
    const token = tokenValue?.trim();
    if (
        !token ||
        Buffer.byteLength(token) > MAX_GATEWAY_TOKEN_BYTES ||
        hasLineBreakOrNullByte(token)
    ) {
        throw new Error(`${label} must be a valid single-line token`);
    }
    const tokenDirectory = path.dirname(filePath);
    ensureRealDirectory(tokenDirectory);
    if (existsSync(filePath) && !isRealRegularFile(filePath)) {
        throw new Error(`${label} path must be a real regular file`);
    }
    const temporaryPath = path.join(
        tokenDirectory,
        `.gateway-token-${Bun.randomUUIDv7()}.tmp`
    );
    try {
        writeFileSync(temporaryPath, `${token}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporaryPath, filePath);
        chmodSync(filePath, 0o600);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

export function materializeGatewayCredentials(
    config: PullRequestPreviewConfig,
    upstreamToken: string | undefined
): void {
    if (
        path.resolve(config.gatewayTokenFile) ===
        path.resolve(config.gatewayUpstreamTokenFile)
    ) {
        throw new Error("PR dev client and upstream Gateway token paths must differ");
    }
    materializeGatewayTokenFile(
        config.gatewayUpstreamTokenFile,
        upstreamToken,
        "Persisted Gateway token"
    );
    materializeGatewayTokenFile(
        config.gatewayTokenFile,
        randomBytes(32).toString("base64url"),
        "PR dev Gateway proxy token"
    );
}

export function removeMaterializedGatewayTokenFile(
    filePath: string,
    label: string
): void {
    if (!existsSync(filePath)) return;
    if (!isRealRegularFile(filePath)) {
        throw new Error(`${label} path must be a real regular file`);
    }
    rmSync(filePath, { force: true });
}

export function removeMaterializedGatewayCredentials(
    config: PullRequestPreviewConfig
): void {
    const errors: Error[] = [];
    for (const [filePath, label] of [
        [config.gatewayTokenFile, "PR dev Gateway proxy token"],
        [config.gatewayUpstreamTokenFile, "PR dev upstream Gateway token"],
    ] as const) {
        try {
            removeMaterializedGatewayTokenFile(filePath, label);
        } catch (error) {
            errors.push(
                error instanceof Error ? error : new Error(`${label} cleanup failed`)
            );
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "PR dev Gateway credential cleanup failed");
    }
}
