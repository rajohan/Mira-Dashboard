import { describe, expect, test } from "bun:test";

import { resolveDevelopmentFrontendConfiguration } from "./developmentFrontendConfig.ts";

describe("development frontend configuration", () => {
    test("uses the isolated loopback defaults", () => {
        expect(resolveDevelopmentFrontendConfiguration({})).toEqual({
            apiTarget: "http://127.0.0.1:3206",
            cookieNamespace: "__Host-mira_dashboard_dev_3205",
            host: "127.0.0.1",
            hotReload: true,
            port: 3205,
            publicOrigin: "http://localhost:3205",
        });
    });

    test("accepts the dedicated remote HTTPS origin", () => {
        expect(
            resolveDevelopmentFrontendConfiguration({
                DASHBOARD_API_TARGET: "http://127.0.0.1:4216/",
                HOST: "127.0.0.1",
                MIRA_DASHBOARD_DEV_HOT_RELOAD: "0",
                MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN:
                    "https://dashboard.example.ts.net:4445/",
                MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT: "4217",
                PORT: "4215",
            })
        ).toMatchObject({
            apiTarget: "http://127.0.0.1:4216",
            hotReload: false,
            port: 4215,
            publicOrigin: "https://dashboard.example.ts.net:4445",
            remoteProxyPort: 4217,
        });
    });

    test.each([
        [{ HOST: "0.0.0.0" }, "must bind to 127.0.0.1"],
        [{ PORT: "0" }, "PORT must be an integer"],
        [{ DASHBOARD_API_TARGET: "http://192.0.2.4:3206" }, "loopback HTTP"],
        [{ DASHBOARD_API_TARGET: "http://127.0.0.1:3205" }, "ports must differ"],
        [
            {
                MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://dashboard.example.ts.net:3445",
                MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT: "3205",
            },
            "ports must differ",
        ],
        [{ MIRA_DASHBOARD_DEV_HOT_RELOAD: "yes" }, "must be 0 or 1"],
        [{ MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "http://example.test" }, "must be HTTPS"],
        [
            { MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE: "invalid cookie" },
            "namespace is invalid",
        ],
    ])("fails closed before listening for %o", (environment, message) => {
        expect(() => resolveDevelopmentFrontendConfiguration(environment)).toThrow(
            message
        );
    });
});
