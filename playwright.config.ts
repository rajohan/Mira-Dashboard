import { defineConfig, devices } from "@playwright/test";

const backendPort = 3201;
const frontendPort = 5173;

export default defineConfig({
    testDir: "./tests/e2e",
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL: `http://127.0.0.1:${frontendPort}`,
        trace: "on-first-retry",
    },
    webServer: [
        {
            command: `npm --prefix backend run build && mkdir -p .test-openclaw/media && OPENCLAW_HOME=$PWD/.test-openclaw PORT=${backendPort} node backend/dist/server.js`,
            url: `http://127.0.0.1:${backendPort}/api/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        },
        {
            command: `DASHBOARD_API_TARGET=http://127.0.0.1:${backendPort} VITE_DASHBOARD_WS_PORT=${backendPort} npm run dev -- --host 127.0.0.1 --port ${frontendPort}`,
            url: `http://127.0.0.1:${frontendPort}`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        },
    ],
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
});
