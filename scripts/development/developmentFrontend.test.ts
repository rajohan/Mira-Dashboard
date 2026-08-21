import { expect, test } from "bun:test";

import { startDevelopmentFrontend } from "../developmentFrontend.ts";
import developmentFixture from "./testSupport/developmentFrontendFixture.html";

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
