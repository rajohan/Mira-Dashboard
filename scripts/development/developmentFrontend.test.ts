import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { startDevelopmentFrontend } from "../developmentFrontend.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import developmentFixture from "./testSupport/developmentFrontendFixture.html";

async function curlUnix(
    socketPath: string,
    url: string,
    headers: readonly string[] = []
) {
    const child = Bun.spawn(
        [
            "/usr/bin/curl",
            "--silent",
            "--show-error",
            "--noproxy",
            "*",
            "--unix-socket",
            socketPath,
            ...headers.flatMap((header) => ["--header", header]),
            url,
        ],
        { stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { exitCode, stderr, stdout } as const;
}

test("serves remote Bun HMR, React Fast Refresh, and React Compiler output together", async () => {
    const publicHost = "dashboard.example.ts.net:3445";
    const runtime = await startDevelopmentFrontend(
        {
            apiTarget: "http://127.0.0.1:65534",
            cookieNamespace: "__Host-mira_dashboard_dev_hmr",
            host: "127.0.0.1",
            hotReload: true,
            port: 0,
            publicOrigin: `https://${publicHost}`,
            remoteProxyPort: 0,
        },
        { dashboardRoute: developmentFixture }
    );

    try {
        const remoteProxyPort = runtime.remoteProxy?.port;
        if (remoteProxyPort === undefined) {
            throw new Error("Development remote proxy did not open a TCP listener");
        }
        const origin = `http://127.0.0.1:${remoteProxyPort}`;
        const frontendResponse = await fetch(origin, {
            headers: { host: publicHost },
        });
        expect(frontendResponse.ok).toBeTrue();
        const html = await frontendResponse.text();
        const clientScript = html.match(
            /<script[^>]+src="([^"]+)"[^>]+data-bun-dev-server-script/u
        )?.[1];
        if (clientScript === undefined) {
            throw new Error("Bun did not inject its development client script");
        }
        const clientResponse = await fetch(new URL(clientScript, origin), {
            headers: { host: publicHost },
        });
        const javascript = await clientResponse.text();

        expect(javascript).toContain("/_bun/hmr");
        expect(javascript).toContain("react-refresh/runtime");
        expect(javascript).toContain("developmentFrontendFixtureRoot");
        expect(javascript).toContain("useMemoCache");
    } finally {
        await runtime.stop(true);
    }
}, 30_000);

test("starts and stops the exported frontend runtime in process", async () => {
    const runtime = await startDevelopmentFrontend({
        apiTarget: "http://127.0.0.1:65534",
        cookieNamespace: "__Host-mira_dashboard_dev_in_process",
        host: "127.0.0.1",
        hotReload: false,
        port: 0,
        publicOrigin: "http://localhost",
    });

    try {
        expect(runtime.frontend.port).toBeGreaterThan(0);
        expect(runtime.remoteProxy).toBeUndefined();
    } finally {
        await runtime.stop(true);
    }
});

test("serves frontend and single-hop authenticated API traffic through Unix ingress", async () => {
    const root = await mkdtemp("/tmp/mfi-");
    const ingressSocket = path.join(root, "preview.sock");
    const publicHost = "preview.example.test";
    const backendCookies: Array<string | null> = [];
    const backend = Bun.serve({
        fetch(request) {
            backendCookies.push(request.headers.get("cookie"));
            return Response.json({ ready: true });
        },
        hostname: "127.0.0.1",
        port: 0,
    });
    const runtime = await startDevelopmentFrontend(
        {
            apiTarget: backend.url.origin,
            cookieNamespace: "__Host-mira_dashboard_preview_test",
            host: "127.0.0.1",
            hotReload: false,
            ingressSocket,
            port: 0,
            publicOrigin: `https://${publicHost}`,
        },
        { dashboardRoute: developmentFixture }
    );

    try {
        const frontend = await curlUnix(ingressSocket, "http://127.0.0.1/", [
            `Host: ${publicHost}`,
        ]);
        expect(frontend.exitCode, frontend.stderr).toBe(0);
        expect(frontend.stdout).toContain("development-frontend-fixture");

        const api = await curlUnix(ingressSocket, "http://127.0.0.1/api/test", [
            `Host: ${publicHost}`,
            "Cookie: __Host-mira_dashboard_preview_test_session=preview-session",
        ]);
        expect(api.exitCode, api.stderr).toBe(0);
        expect(api.stdout).toContain('"ready":true');
        expect(backendCookies).toEqual(["__Host-mira_dashboard_session=preview-session"]);
    } finally {
        await runtime.stop(true);
        await backend.stop(true);
        await rm(root, { force: true, recursive: true });
    }
}, 30_000);

test("closes Unix ingress when later proxy startup fails", async () => {
    const root = await mkdtemp("/tmp/mfr-");
    const ingressSocket = path.join(root, "preview.sock");
    const occupied = Bun.serve({ fetch: () => new Response("occupied"), port: 0 });
    try {
        expect(
            await rejectionError(
                startDevelopmentFrontend({
                    apiTarget: "http://127.0.0.1:65534",
                    cookieNamespace: "__Host-mira_dashboard_preview_rollback",
                    host: "127.0.0.1",
                    hotReload: false,
                    ingressSocket,
                    port: 0,
                    publicOrigin: "https://preview.example.test",
                    remoteProxyPort: occupied.port,
                })
            )
        ).toBeInstanceOf(Error);
        const probe = await curlUnix(ingressSocket, "http://127.0.0.1/");
        expect(probe.exitCode).not.toBe(0);
    } finally {
        await occupied.stop(true);
        await rm(root, { force: true, recursive: true });
    }
}, 30_000);
