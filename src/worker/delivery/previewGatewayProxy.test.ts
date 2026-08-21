import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    buildPreviewGatewaySocketSpecification,
    createPreviewGatewayCapability,
    invokePreviewGateway,
} from "./previewGatewayProxy.ts";

describe("preview Gateway capability", () => {
    test("creates a random bounded in-memory capability and rejects unauthorized operations", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-gateway-"));
        await mkdir(path.join(root, "state"), { mode: 0o700 });
        try {
            const capability = await createPreviewGatewayCapability({
                capabilityRoot: path.join(root, "state"),
            });
            const specification = buildPreviewGatewaySocketSpecification(capability);
            expect(specification.socketMode).toBe(0o600);
            let calls = 0;
            const port = {
                invoke: () => {
                    calls += 1;
                    return Promise.resolve({ body: new Uint8Array([1]) });
                },
            };

            expect(
                invokePreviewGateway(specification, port, {
                    body: new Uint8Array(),
                    capability: "wrong",
                    operation: "session-status",
                })
            ).rejects.toMatchObject({ reason: "invalid-request" });
            expect(calls).toBe(0);

            expect(
                await invokePreviewGateway(specification, port, {
                    body: new Uint8Array([42]),
                    capability: capability.token,
                    operation: "session-status",
                })
            ).toEqual({ body: new Uint8Array([1]) });
            expect(calls).toBe(1);

            const outside = path.join(root, "outside");
            const forged = path.join(root, "forged");
            await mkdir(outside, { mode: 0o700 });
            await symlink(outside, forged);
            expect(
                createPreviewGatewayCapability({ capabilityRoot: forged })
            ).rejects.toMatchObject({ reason: "path-unsafe" });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
