import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, before, describe, it } from "node:test";

import express from "express";

import { __testing } from "./stt.js";

function setGlobalProperty<Key extends keyof typeof globalThis>(
    key: Key,
    value: (typeof globalThis)[Key]
): void {
    Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
    });
}

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalFetch = fetch;
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

async function transcribe(
    server: TestServer,
    body: Buffer,
    contentType: string | null = "audio/wav"
) {
    return originalFetch(`${server.baseUrl}/api/stt/transcribe`, {
        method: "POST",
        headers: contentType === null ? undefined : { "Content-Type": contentType },
        body,
    });
}

describe("STT routes", () => {
    let server: TestServer;
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

    before(async () => {
        server = await startServer();
    });

    afterEach(() => {
        setGlobalProperty("fetch", originalFetch);
        if (originalApiKey === undefined) {
            delete process.env.ELEVENLABS_API_KEY;
        } else {
            process.env.ELEVENLABS_API_KEY = originalApiKey;
        }
    });

    after(async () => {
        await server.close();
        setGlobalProperty("fetch", originalFetch);
    });

    it("requires an audio payload and ElevenLabs configuration", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        const missingBody = await originalFetch(`${server.baseUrl}/api/stt/transcribe`, {
            method: "POST",
        });
        assert.equal(missingBody.status, 400);
        assert.deepEqual(await missingBody.json(), { error: "Missing audio payload" });

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
        setGlobalProperty("fetch", async (url, init) => {
            fetchCalls.push({ url: String(url), init: init || {} });
            return Response.json({ text: "  hei Raymond  " });
        });

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
        setGlobalProperty("fetch", async () =>
            Response.json({
                words: [{ text: "hei" }, null, { text: 123 }, { text: "der" }],
            })
        );

        const words = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(words.status, 200);
        assert.deepEqual(await words.json(), {
            provider: "elevenlabs",
            text: "hei der",
        });

        setGlobalProperty(
            "fetch",
            async () => new Response("bad audio", { status: 400 })
        );
        const error = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(error.status, 500);
        assert.deepEqual(await error.json(), {
            error: "ElevenLabs STT failed (400): bad audio",
        });

        setGlobalProperty("fetch", async () => {
            throw "network unavailable";
        });
        const stringError = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(stringError.status, 500);
        assert.deepEqual(await stringError.json(), { error: "network unavailable" });

        setGlobalProperty("fetch", async () => {
            throw null;
        });
        const unknownError = await transcribe(server, Buffer.from([1, 2, 3]));
        assert.equal(unknownError.status, 500);
        assert.deepEqual(await unknownError.json(), {
            error: "Failed to transcribe audio",
        });
    });

    it("handles content type variants, empty transcripts, and concurrent requests", async () => {
        process.env.ELEVENLABS_API_KEY = "test-key";
        const fileNames: string[] = [];
        let releaseFetch!: () => void;
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        const blockedFetch = new Promise<Response>((resolve) => {
            releaseFetch = () => resolve(Response.json(null));
        });
        setGlobalProperty("fetch", async (_url, init) => {
            resolveStarted();
            const body = init?.body;
            assert.equal(body instanceof FormData, true);
            const file = (body as FormData).get("file") as File;
            fileNames.push(file.name);
            return blockedFetch;
        });

        const first = transcribe(server, Buffer.from([1, 2, 3]), "audio/mpeg");
        await started;
        const busy = await transcribe(server, Buffer.from([4, 5, 6]), "audio/ogg");
        assert.equal(busy.status, 429);
        assert.deepEqual(await busy.json(), {
            error: "Another transcription is already running",
        });
        releaseFetch();
        const empty = await first;
        assert.equal(empty.status, 200);
        assert.deepEqual(await empty.json(), { provider: "elevenlabs", text: "" });
        assert.deepEqual(fileNames, ["recording.mp3"]);

        setGlobalProperty("fetch", async (_url, init) => {
            const file = ((init?.body as FormData).get("file") as File).name;
            return Response.json({ text: file });
        });

        const m4a = await transcribe(server, Buffer.from([1]), "audio/m4a");
        assert.deepEqual(await m4a.json(), {
            provider: "elevenlabs",
            text: "recording.m4a",
        });
        const webmDefault = await transcribe(
            server,
            Buffer.from([1]),
            "application/octet-stream"
        );
        assert.deepEqual(await webmDefault.json(), {
            provider: "elevenlabs",
            text: "recording.webm",
        });
        const ogg = await transcribe(server, Buffer.from([1]), "audio/ogg");
        assert.deepEqual(await ogg.json(), {
            provider: "elevenlabs",
            text: "recording.ogg",
        });
        const wav = await transcribe(server, Buffer.from([1]), "audio/wav");
        assert.deepEqual(await wav.json(), {
            provider: "elevenlabs",
            text: "recording.wav",
        });

        setGlobalProperty("fetch", async (_url, init) => {
            const file = (init?.body as FormData).get("file") as File;
            return Response.json({ text: `${file.name}:${file.type}` });
        });
        assert.equal(
            await __testing.transcribeWithElevenLabs(Buffer.from([1]), " ".repeat(3)),
            "recording.webm:application/octet-stream"
        );
        assert.equal(
            await __testing.transcribeWithElevenLabs(Buffer.from([1]), [
                " audio/wav ",
                "audio/ogg",
            ]),
            "recording.wav:audio/wav"
        );

        setGlobalProperty("fetch", async () => Response.json({}));
        const missingWords = await transcribe(server, Buffer.from([1]));
        assert.deepEqual(await missingWords.json(), { provider: "elevenlabs", text: "" });

        assert.equal(__testing.audioExtension(), ".webm");
        assert.equal(__testing.audioExtension("application/octet-stream"), ".webm");
        assert.equal(__testing.audioExtension("audio/wav"), ".wav");
        assert.equal(__testing.transcriptTextFromElevenLabs({}), "");
        assert.equal(
            await __testing.readResponseTextFallback({
                text: async () => {
                    throw new Error("body unavailable");
                },
            } as unknown as Response),
            ""
        );

        setGlobalProperty(
            "fetch",
            async () => new Response("", { status: 502, statusText: "Bad Gateway" })
        );
        const statusOnlyError = await transcribe(server, Buffer.from([1]));
        assert.equal(statusOnlyError.status, 500);
        assert.deepEqual(await statusOnlyError.json(), {
            error: "ElevenLabs STT failed (502): Bad Gateway",
        });
    });
});
