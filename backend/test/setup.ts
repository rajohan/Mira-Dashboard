import { afterEach, jest } from "bun:test";

process.env.NODE_ENV = "test";

afterEach(() => {
    jest.restoreAllMocks();
});
