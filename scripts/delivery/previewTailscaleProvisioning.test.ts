import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import {
    previewTailscaleOperatorUser,
    previewTailscaleProvisioningReleaseArtifactPaths,
} from "./previewTailscaleProvisioningPolicy.ts";
import {
    installPreviewTailscaleOperator,
    type PreviewTailscaleOperatorProcessRequest,
    type PreviewTailscaleOperatorProcessResult,
    verifyPreviewTailscaleOperator,
} from "./provisioning/preview-tailscale/operator.ts";

const encoder = new TextEncoder();

function result(value: unknown, exitCode = 0): PreviewTailscaleOperatorProcessResult {
    return Object.freeze({
        exitCode,
        stderr: new Uint8Array(),
        stdout:
            value === undefined
                ? new Uint8Array()
                : encoder.encode(JSON.stringify(value)),
    });
}

function fixture(operator = previewTailscaleOperatorUser) {
    const requests: PreviewTailscaleOperatorProcessRequest[] = [];
    return Object.freeze({
        dependencies: {
            processRunner(request: PreviewTailscaleOperatorProcessRequest) {
                requests.push(request);
                if (request.command.includes("set")) return Promise.resolve(result({}));
                return Promise.resolve(result({ OperatorUser: operator }));
            },
            userId: 0,
        },
        requests,
    });
}

describe("preview Tailscale operator provisioning", () => {
    test("verifies the exact persisted operator through a fixed read-only command", async () => {
        const context = fixture();
        await verifyPreviewTailscaleOperator(context.dependencies);
        expect(context.requests).toHaveLength(1);
        expect(context.requests[0]?.command).toEqual([
            "/usr/bin/tailscale",
            "debug",
            "prefs",
        ]);
        expect(context.requests[0]?.environment).toEqual({
            HOME: "/nonexistent",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: "/usr/bin:/bin",
        });
    });

    test("applies only the fixed delegation as root and verifies it afterwards", async () => {
        const context = fixture();
        await installPreviewTailscaleOperator(context.dependencies);
        expect(context.requests.map(({ command }) => command)).toEqual([
            ["/usr/bin/tailscale", "set", "--operator=ubuntu"],
            ["/usr/bin/tailscale", "debug", "prefs"],
        ]);

        const nonRoot = await rejectionError(
            installPreviewTailscaleOperator({
                ...context.dependencies,
                userId: 1001,
            })
        );
        expect(nonRoot.message).toBe("Preview Tailscale operator provisioning failed");
    });

    test("fails closed on absent, different, invalid, or failed preferences", async () => {
        for (const output of [{}, { OperatorUser: "root" }, { OperatorUser: 42 }]) {
            const error = await rejectionError(
                verifyPreviewTailscaleOperator({
                    processRunner: () => Promise.resolve(result(output)),
                })
            );
            expect(error.message).toBe("Preview Tailscale operator provisioning failed");
        }
        const failedCommand = await rejectionError(
            verifyPreviewTailscaleOperator({
                processRunner: () => Promise.resolve(result(undefined, 1)),
            })
        );
        expect(failedCommand.message).toBe(
            "Preview Tailscale operator provisioning failed"
        );
    });

    test("ships the complete bounded bootstrap subtree in release identity", async () => {
        const sourceRoot = path.join(import.meta.dir, "provisioning/preview-tailscale");
        const sourceEntries = await readdir(sourceRoot);
        const entries = sourceEntries.toSorted();
        expect(entries).toEqual(["README.md", "operator.ts", "policy.ts"]);
        expect(previewTailscaleProvisioningReleaseArtifactPaths).toEqual(
            entries.map(
                (name) => `scripts/delivery/provisioning/preview-tailscale/${name}`
            )
        );
    });
});
