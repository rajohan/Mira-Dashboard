import { describe, expect, it } from "bun:test";

import { jsonWithEtag } from "../src/http.ts";

describe("private JSON validators", () => {
    it("returns 304 for a matching ETag without making the response public", async () => {
        const first = jsonWithEtag(new Request("https://dashboard.test/api/poll"), {
            items: ["one"],
        });
        const etag = first.headers.get("etag");

        expect(first.status).toBe(200);
        expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);
        expect(first.headers.get("cache-control")).toBe("private, no-cache");
        expect(first.headers.get("vary")).toBe("Cookie, Authorization");
        await expect(first.json()).resolves.toEqual({ items: ["one"] });

        const revalidated = jsonWithEtag(
            new Request("https://dashboard.test/api/poll", {
                headers: { "If-None-Match": `W/${etag}` },
            }),
            { items: ["one"] }
        );
        expect(revalidated.status).toBe(304);
        await expect(revalidated.text()).resolves.toBe("");
    });

    it("returns a new body when the validator no longer matches", async () => {
        const response = jsonWithEtag(
            new Request("https://dashboard.test/api/poll", {
                headers: { "If-None-Match": '"old"' },
            }),
            { items: ["new"] }
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ items: ["new"] });
    });
});
