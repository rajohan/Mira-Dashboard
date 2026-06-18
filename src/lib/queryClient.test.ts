import { describe, expect, it } from "bun:test";

import { AUTO_REFRESH_MS, queryClient } from "./queryClient";

describe("queryClient", () => {
    it("exports a QueryClient instance", () => {
        expect(queryClient).toBeDefined();
        expect(typeof queryClient.getQueryData).toBe("function");
    });

    it("exports AUTO_REFRESH_MS constant", () => {
        expect(AUTO_REFRESH_MS).toBe(5000);
    });
});
