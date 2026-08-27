import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogSourceCatalog, hostTextLogManifest } from "./sourceCatalog.ts";

const temporaryDirectories: string[] = [];

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "mira-log-catalog-"));
    temporaryDirectories.push(root);
    const dashboard = path.join(root, "dashboard");
    const host = path.join(root, "host");
    const openclaw = path.join(root, "openclaw");
    await Promise.all([
        mkdir(dashboard),
        mkdir(host),
        mkdir(openclaw),
        writeFile(path.join(root, "outside.log"), "outside"),
    ]);
    return { dashboard, host, openclaw, root };
}

const fixtureOwnerId = typeof process.getuid === "function" ? process.getuid() : 0;

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true }))
    );
});

describe("named log source catalog", () => {
    test("lists exact host, dashboard, and bounded OpenClaw source identities without paths", async () => {
        const roots = await fixture();
        await Promise.all([
            writeFile(
                path.join(roots.dashboard, "web.ndjson"),
                '{"timestamp":"2026-08-27T20:00:00.000Z"}\n'
            ),
            writeFile(path.join(roots.dashboard, "web-stdout.log"), "ready\n"),
            writeFile(path.join(roots.host, "auth.log"), "accepted\n"),
            writeFile(path.join(roots.openclaw, "openclaw-2026-08-09.log"), "hello\n"),
            writeFile(path.join(roots.openclaw, "not-a-log.txt"), "ignored\n"),
        ]);
        const catalog = createLogSourceCatalog({
            dashboardLogsRoot: roots.dashboard,
            hostLogsRoot: roots.host,
            hostOwnerIds: [fixtureOwnerId],
            now: () => 123,
            openClawLogsRoot: roots.openclaw,
        });
        const output = await catalog.list();
        expect(output.observedAtMs).toBe(123);
        expect(output.sources.map(({ id }) => id)).toContain("openclaw.20260809");
        expect(output.sources.map(({ id }) => id)).toContain("host.auth");
        expect(output.sources.find(({ id }) => id === "dashboard.web")).toMatchObject({
            availability: "available",
            group: "dashboard",
            id: "dashboard.web",
            label: "Dashboard web",
        });
        expect(output.sources.find(({ id }) => id === "host.auth")?.availability).toBe(
            "available"
        );
        expect(output.sources).not.toContainEqual(
            expect.objectContaining({ path: expect.anything() })
        );
        expect(output.sources.filter(({ group }) => group === "host")).toHaveLength(
            hostTextLogManifest.length
        );
        expect(await catalog.resolve("../../etc/passwd")).toBeUndefined();
    });

    test("marks symlink and hardlink source entries unreadable", async () => {
        const roots = await fixture();
        await symlink(
            path.join(roots.root, "outside.log"),
            path.join(roots.host, "auth.log")
        );
        const catalog = createLogSourceCatalog({
            dashboardLogsRoot: roots.dashboard,
            hostLogsRoot: roots.host,
            hostOwnerIds: [fixtureOwnerId],
            openClawLogsRoot: roots.openclaw,
        });
        const output = await catalog.list();
        expect(output.sources.find(({ id }) => id === "host.auth")).toMatchObject({
            availability: "unreadable",
        });

        await rm(path.join(roots.host, "auth.log"));
        await link(
            path.join(roots.root, "outside.log"),
            path.join(roots.host, "auth.log")
        );
        const hardlinked = await catalog.list();
        expect(hardlinked.sources.find(({ id }) => id === "host.auth")).toMatchObject({
            availability: "unreadable",
        });
    });

    test("rejects a symlinked dynamic root and invalid lexical roots", async () => {
        const roots = await fixture();
        const linked = path.join(roots.root, "linked");
        await symlink(roots.openclaw, linked);
        const catalog = createLogSourceCatalog({
            dashboardLogsRoot: roots.dashboard,
            hostLogsRoot: roots.host,
            hostOwnerIds: [fixtureOwnerId],
            openClawLogsRoot: linked,
        });
        const output = await catalog.list();
        expect(output.sources.some(({ group }) => group === "openclaw")).toBe(false);
        expect(() => createLogSourceCatalog({ dashboardLogsRoot: "relative" })).toThrow(
            "Log source root is invalid"
        );
    });
});
