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
    const { default: sttRoutes } = await import("./stt.js");
    const app = express();
    sttRoutes(app, express);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function transcribe(server: TestServer, body: Buffer, contentType = "audio/wav") {
    return originalFetch(`${server.baseUrl}/api/stt/transcribe`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
    });
}

describe("STT routes", () => {
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

    it("requires an audio payload and ElevenLabs configuration", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        const missingAudio = await transcribe(server, Buffer.alloc(0));
        assert.equal(missingAudio.status, 400);
        assert.deepEqual(await missingAudio.json(), { error: "Missing audio payload" });

        delete process.env.ELEVENLABS_API_KEY;
        const noKey = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(noKey.status, 500);
        assert.deepEqual(await noKey.json(), {
            error: "ELEVENLABS_API_KEY is not configured",
        });
    });

    it("returns transcript text from ElevenLabs text responses", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        fetchCalls.length = 0;
        globalThis.fetch = async (url, init) => {
            fetchCalls.push({ url: String(url), init: init || {} });
            return Response.json({ text: "  hei Raymond  " });
        };

        const response = await transcribe(server, Buffer.from([1, 2, 3]), "audio/mp4");
        const body = (await response.json()) as { provider: string; text: string };

        assert.equal(response.status, 200);
        assert.deepEqual(body, { provider: "elevenlabs", text: "hei Raymond" });
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0]?.url, "https://api.elevenlabs.io/v1/speech-to-text");
        assert.equal(
            (fetchCalls[0]?.init.headers as Record<string, string>)["xi-api-key"],
            "test-key"
        );
        assert.equal(fetchCalls[0]?.init.body instanceof FormData, true);
    });

    it("falls back to word-level transcripts and surfaces provider errors", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        globalThis.fetch = async () =>
            Response.json({ words: [{ text: "hei" }, { text: "der" }] });

        const words = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(words.status, 200);
        assert.deepEqual(await words.json(), { provider: "elevenlabs", text: "hei der" });

        globalThis.fetch = async () => new Response("bad audio", { status: 400 });
        const error = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(error.status, 500);
        assert.deepEqual(await error.json(), {
            error: "ElevenLabs STT failed (400): bad audio",
        });
    });
});
