import { afterEach, jest } from "bun:test";

process.env.NODE_ENV = "test";
process.env.DOTENV_CONFIG_QUIET = "true";

afterEach(() => {
    jest.restoreAllMocks();
});
