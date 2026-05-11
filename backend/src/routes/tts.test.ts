import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.ELEVENLABS_API_KEY;

async function startServer(): Promise<TestServer> {
    const { default: ttsRoutes } = await import("./tts.js");
    const app = express();
    ttsRoutes(app, express);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function postJson<T>(
    server: TestServer,
    body: unknown
): Promise<{
    status: number;
    body: T;
}> {
    const response = await originalFetch(`${server.baseUrl}/api/tts/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("TTS routes", () => {
    let server: TestServer;
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

    before(async () => {
        server = await startServer();
    });

    after(async () => {
        await server.close();
        globalThis.fetch = originalFetch;
        if (originalApiKey === undefined) {
            delete process.env.ELEVENLABS_API_KEY;
        } else {
            process.env.ELEVENLABS_API_KEY = originalApiKey;
        }
    });

    it("requires ElevenLabs configuration and text", async () => {
        delete process.env.ELEVENLABS_API_KEY;

        const noKey = await postJson<{ error: string }>(server, { text: "hello" });
        assert.equal(noKey.status, 500);
        assert.equal(noKey.body.error, "ELEVENLABS_API_KEY is not configured");

        process.env.ELEVENLABS_API_KEY = "test-key";
        const missingText = await postJson<{ error: string }>(server, { text: "   " });
        assert.equal(missingText.status, 400);
        assert.equal(missingText.body.error, "Missing text");

        const tooLong = await postJson<{ error: string }>(server, {
            text: "x".repeat(4001),
        });
        assert.equal(tooLong.status, 400);
        assert.equal(tooLong.body.error, "Text is too long. Max is 4000 characters.");
    });

    it("proxies successful speech generation as MPEG audio", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        fetchCalls.length = 0;
        globalThis.fetch = async (url, init) => {
            fetchCalls.push({ url: String(url), init: init || {} });
            return new Response(Buffer.from([1, 2, 3]), { status: 200 });
        };

        const response = await originalFetch(`${server.baseUrl}/api/tts/speak`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "  Hello Mira  " }),
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "audio/mpeg");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
        assert.equal(fetchCalls.length, 1);
        assert.match(fetchCalls[0]?.url || "", /\/v1\/text-to-speech\//u);
        assert.equal(
            (fetchCalls[0]?.init.headers as Record<string, string>)["xi-api-key"],
            "test-key"
        );
        assert.deepEqual(JSON.parse(String(fetchCalls[0]?.init.body)), {
            text: "Hello Mira",
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        });
    });

    it("forwards ElevenLabs error responses", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        globalThis.fetch = async () => new Response("quota exceeded", { status: 429 });

        const response = await postJson<{ error: string }>(server, { text: "hello" });

        assert.equal(response.status, 429);
        assert.equal(response.body.error, "quota exceeded");
    });
});
