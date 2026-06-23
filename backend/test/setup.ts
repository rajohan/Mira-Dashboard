import { afterEach, jest } from "bun:test";

process.env.NODE_ENV = "test";
process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH ??= "1";

afterEach(() => {
    jest.restoreAllMocks();
});
