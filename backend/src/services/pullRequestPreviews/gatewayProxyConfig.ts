import { timingSafeEqual } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
} from "node:fs";
import path from "node:path";

import { loadOrCreateDeviceIdentity } from "../../lib/openclawGatewayClient/client.ts";
import { hasLineBreakOrNullByte } from "../../lib/values.ts";
import type { PullRequestPreviewGatewayProxyOptions } from "./gatewayProxyTypes.ts";

const MAX_GATEWAY_TOKEN_BYTES = 16 * 1024;

export function normalizedGatewayToken(value: string, label: string): string {
    const token = value.trim();
    if (
        !token ||
        Buffer.byteLength(token) > MAX_GATEWAY_TOKEN_BYTES ||
        hasLineBreakOrNullByte(token)
    ) {
        throw new TypeError(`${label} must be a valid single-line token`);
    }
    return token;
}

export function areGatewayTokensEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
        leftBuffer.length === rightBuffer.length &&
        timingSafeEqual(leftBuffer, rightBuffer)
    );
}

function configuredPort(value: string | undefined): number {
    if (!value || !/^\d+$/u.test(value)) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT must be an integer"
        );
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT must be between 1 and 65535"
        );
    }
    return port;
}

function configuredUpstreamUrl(value: string | undefined): string {
    if (!value?.trim()) {
        throw new TypeError("MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL is required");
    }
    const url = new URL(value);
    if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
    ) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL must be ws:// or wss:// without credentials or a fragment"
        );
    }
    return url.href;
}

function absoluteFilePath(name: string, value: string | undefined): string {
    if (!value?.trim() || !path.isAbsolute(value)) {
        throw new TypeError(`${name} must be an absolute path`);
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must not be the filesystem root`);
    }
    return resolved;
}

function readSecretFile(filePath: string, label: string): string {
    const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(descriptor);
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size > MAX_GATEWAY_TOKEN_BYTES ||
            (stat.mode & 0o077) !== 0
        ) {
            throw new Error(`${label} must be a private single-link regular file`);
        }
        return normalizedGatewayToken(readFileSync(descriptor, "utf8"), label);
    } finally {
        closeSync(descriptor);
    }
}

export function loadPrivatePreviewDeviceIdentity(filePath: string) {
    const directory = path.dirname(filePath);
    const directoryStat = lstatSync(directory);
    if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        (directoryStat.mode & 0o077) !== 0
    ) {
        throw new Error(
            "Preview Gateway proxy identity directory must be a private real directory"
        );
    }
    if (existsSync(filePath)) {
        const fileStat = lstatSync(filePath);
        if (
            !fileStat.isFile() ||
            fileStat.isSymbolicLink() ||
            fileStat.nlink !== 1 ||
            (fileStat.mode & 0o077) !== 0
        ) {
            throw new Error(
                "Preview Gateway proxy identity must be a private single-link regular file"
            );
        }
    }
    const identity = loadOrCreateDeviceIdentity(filePath);
    const createdStat = lstatSync(filePath);
    if (
        !createdStat.isFile() ||
        createdStat.isSymbolicLink() ||
        createdStat.nlink !== 1 ||
        (createdStat.mode & 0o077) !== 0
    ) {
        throw new Error(
            "Preview Gateway proxy identity must be a private single-link regular file"
        );
    }
    return identity;
}

export function pullRequestPreviewGatewayProxyOptionsFromEnvironment(
    environment: Record<string, string | undefined> = process.env
): PullRequestPreviewGatewayProxyOptions {
    const clientTokenFile = absoluteFilePath(
        "MIRA_DASHBOARD_PREVIEW_GATEWAY_CLIENT_TOKEN_FILE",
        environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_CLIENT_TOKEN_FILE
    );
    const upstreamTokenFile = absoluteFilePath(
        "MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_TOKEN_FILE",
        environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_TOKEN_FILE
    );
    return {
        clientToken: readSecretFile(clientTokenFile, "Preview client token file"),
        deviceIdentityFile: absoluteFilePath(
            "MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_IDENTITY_FILE",
            environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_IDENTITY_FILE
        ),
        port: configuredPort(environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT),
        upstreamToken: readSecretFile(
            upstreamTokenFile,
            "Preview upstream Gateway token file"
        ),
        upstreamUrl: configuredUpstreamUrl(
            environment.MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL
        ),
    };
}
