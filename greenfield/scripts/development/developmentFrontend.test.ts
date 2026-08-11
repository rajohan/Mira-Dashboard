import { expect, test } from "bun:test";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function reserveLoopbackPorts(count: number): Promise<readonly number[]> {
    const reservations = Array.from({ length: count }, () =>
        Bun.serve({
            fetch: () => new Response("reserved"),
            hostname: "127.0.0.1",
            port: 0,
        })
    );
    try {
        const ports: number[] = [];
        for (const reservation of reservations) {
            const port = reservation.port;
            if (port === undefined) {
                throw new Error("Bun did not reserve a development port");
            }
            ports.push(port);
        }
        return ports;
    } finally {
        await Promise.all(reservations.map((reservation) => reservation.stop(true)));
    }
}

async function waitForFrontend(
    origin: string,
    child: ReturnType<typeof Bun.spawn>,
    publicHost: string
): Promise<Response> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Development frontend exited ${child.exitCode}`);
        }
        try {
            const response = await fetch(origin, {
                headers: { host: publicHost },
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok) return response;
        } catch {
            // The Bun listener or first HTML bundle is not ready yet.
        }
        await Bun.sleep(50);
    }
    throw new Error("Development frontend did not become ready");
}

async function stopChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const settled = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(2000).then(() => false),
    ]);
    if (!settled && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
    }
}

test("serves remote Bun HMR, React Fast Refresh, and React Compiler output together", async () => {
    const [port, remoteProxyPort, backendPort] = await reserveLoopbackPorts(3);
    if (
        port === undefined ||
        remoteProxyPort === undefined ||
        backendPort === undefined
    ) {
        throw new Error("Bun did not reserve the development ports");
    }
    const publicHost = "dashboard.example.ts.net:3445";
    const origin = `http://127.0.0.1:${remoteProxyPort}`;
    const child = Bun.spawn([process.execPath, "scripts/developmentFrontend.ts"], {
        cwd: repositoryRoot,
        env: {
            DASHBOARD_API_TARGET: `http://127.0.0.1:${backendPort}`,
            HOST: "127.0.0.1",
            LANG: "C.UTF-8",
            MIRA_DASHBOARD_DEV_HOT_RELOAD: "1",
            MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: `https://${publicHost}`,
            MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT: String(remoteProxyPort),
            NODE_ENV: "development",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            PORT: String(port),
            TZ: "UTC",
        },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "ignore",
    });

    try {
        const frontendResponse = await waitForFrontend(origin, child, publicHost);
        const html = await frontendResponse.text();
        const clientScript =
            /<script[^>]+src="([^"]+)"[^>]+data-bun-dev-server-script/u.exec(html)?.[1];
        if (clientScript === undefined) {
            throw new Error("Bun did not inject its development client script");
        }
        const clientResponse = await fetch(new URL(clientScript, origin), {
            headers: { host: publicHost },
        });
        const javascript = await clientResponse.text();

        expect(javascript).toContain("/_bun/hmr");
        expect(javascript).toContain("react-refresh/runtime");
        expect(javascript).toContain("dashboardBrowserRoot");
        expect(javascript).toContain("useMemoCache");
    } finally {
        await stopChild(child);
    }
}, 30_000);
