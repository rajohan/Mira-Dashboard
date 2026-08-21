import { describe, expect, test } from "bun:test";

import {
    DockerBrokerFrameDecoder,
    DockerBrokerProtocolError,
    dockerBrokerFrameMaximumBytes,
    encodeDockerBrokerFrame,
    parseDockerBrokerRequest,
    parseDockerBrokerResponse,
    type DockerBrokerRequest,
    type DockerBrokerResponse,
} from "./dockerBroker.ts";

const requestId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const sourceRevision = "a".repeat(64);
const containerId = "1".repeat(64);

const logsRequest = Object.freeze({
    id: requestId,
    input: { containerId, sourceRevision, tail: 3 },
    operation: "container-logs" as const,
});
const logsResponse = Object.freeze({
    id: requestId,
    operation: "container-logs" as const,
    result: {
        containerId,
        lines: ["2026-08-13T12:00:00.000Z hello 👩‍💻"],
        observedAtMs: 1_700_000_000_000,
        redacted: true as const,
        sourceRevision,
        truncated: false,
    },
    status: "ok" as const,
});

function decodeSingle(frame: Uint8Array): unknown {
    const decoder = new DockerBrokerFrameDecoder();
    const values = decoder.push(frame);
    decoder.finish();
    expect(values).toHaveLength(1);
    return values[0];
}

function rawFrame(body: Uint8Array, declaredLength = body.byteLength): Uint8Array {
    const frame = new Uint8Array(4 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, declaredLength, false);
    frame.set(body, 4);
    return frame;
}

describe("Docker broker framing protocol", () => {
    test("round-trips strict source-bound requests and sanitized results", () => {
        const encodedRequest = encodeDockerBrokerFrame(logsRequest);
        const encodedResponse = encodeDockerBrokerFrame(logsResponse);

        expect(parseDockerBrokerRequest(decodeSingle(encodedRequest))).toEqual(
            logsRequest
        );
        expect(parseDockerBrokerResponse(decodeSingle(encodedResponse))).toEqual(
            logsResponse
        );
        expect(new DataView(encodedRequest.buffer).getUint32(0, false)).toBe(
            encodedRequest.byteLength - 4
        );
    });

    test("decodes arbitrary fragmentation including inside UTF-8 code points", () => {
        const frame = encodeDockerBrokerFrame(logsResponse);
        const decoder = new DockerBrokerFrameDecoder();
        const messages: unknown[] = [];

        for (const byte of frame) {
            messages.push(...decoder.push(new Uint8Array([byte])));
        }
        decoder.finish();

        expect(messages).toEqual([logsResponse]);
    });

    test("decodes coalesced complete frames in order", () => {
        const pruneRequest = parseDockerBrokerRequest({
            id: requestId,
            input: { sourceRevision, target: "volumes" },
            operation: "prune-preview",
        });
        const first = encodeDockerBrokerFrame(logsRequest);
        const second = encodeDockerBrokerFrame(pruneRequest);
        const combined = new Uint8Array(first.byteLength + second.byteLength);
        combined.set(first);
        combined.set(second, first.byteLength);
        const decoder = new DockerBrokerFrameDecoder();

        expect(decoder.push(combined)).toEqual([logsRequest, pruneRequest]);
        decoder.finish();
    });

    test("rejects empty chunks, incomplete frames, and invalid lengths", () => {
        expect(() => new DockerBrokerFrameDecoder().push(new Uint8Array())).toThrow(
            DockerBrokerProtocolError
        );

        const incomplete = new DockerBrokerFrameDecoder();
        expect(incomplete.push(encodeDockerBrokerFrame(logsRequest).slice(0, 7))).toEqual(
            []
        );
        expect(() => incomplete.finish()).toThrow(DockerBrokerProtocolError);

        expect(() =>
            new DockerBrokerFrameDecoder().push(rawFrame(new Uint8Array(), 0))
        ).toThrow(DockerBrokerProtocolError);
        expect(() =>
            new DockerBrokerFrameDecoder().push(
                rawFrame(new Uint8Array(), dockerBrokerFrameMaximumBytes + 1)
            )
        ).toThrow(DockerBrokerProtocolError);
    });

    test("rejects invalid UTF-8, JSON, and aggregate frame overflow", () => {
        expect(() =>
            new DockerBrokerFrameDecoder().push(rawFrame(new Uint8Array([195, 40])))
        ).toThrow(DockerBrokerProtocolError);
        expect(() =>
            new DockerBrokerFrameDecoder().push(
                rawFrame(new TextEncoder().encode("{not-json}"))
            )
        ).toThrow(DockerBrokerProtocolError);
        expect(() =>
            new DockerBrokerFrameDecoder().push(
                new Uint8Array(dockerBrokerFrameMaximumBytes + 5)
            )
        ).toThrow(DockerBrokerProtocolError);
    });

    test("bounds encoded frames before allocation crosses the protocol budget", () => {
        const oversized = {
            ...logsResponse,
            result: {
                ...logsResponse.result,
                lines: ["x".repeat(dockerBrokerFrameMaximumBytes)],
            },
        } as unknown as DockerBrokerResponse;

        expect(() => encodeDockerBrokerFrame(oversized)).toThrow(
            DockerBrokerProtocolError
        );
        expect(encodeDockerBrokerFrame(logsRequest).byteLength).toBeLessThanOrEqual(
            dockerBrokerFrameMaximumBytes + 4
        );
    });

    test("strict parsers reject invalid ids, selectors, payload drift, and mismatched results", () => {
        for (const invalid of [
            { ...logsRequest, id: "not-a-uuid" },
            {
                ...logsRequest,
                input: { ...logsRequest.input, containerId: "short" },
            },
            {
                ...logsRequest,
                input: { ...logsRequest.input, sourceRevision: "short" },
            },
            {
                ...logsRequest,
                input: { ...logsRequest.input, extra: "forbidden" },
            },
            { ...logsRequest, operation: "generic-exec" },
        ]) {
            expect(() => parseDockerBrokerRequest(invalid)).toThrow();
        }

        for (const invalid of [
            { ...logsResponse, id: "not-a-uuid" },
            {
                ...logsResponse,
                result: { ...logsResponse.result, redacted: false },
            },
            { ...logsResponse, operation: "prune-preview" },
            {
                id: requestId,
                reason: "private-provider-error",
                status: "error",
            },
        ]) {
            expect(() => parseDockerBrokerResponse(invalid)).toThrow();
        }
    });

    test("protocol failures never retain peer content", () => {
        const privateText = "password=private-broker-secret";
        let failure: unknown;
        try {
            new DockerBrokerFrameDecoder().push(
                rawFrame(new TextEncoder().encode(`{${privateText}`))
            );
        } catch (error) {
            failure = error;
        }

        expect(failure).toMatchObject({
            message: "Docker broker protocol failed",
            name: "DockerBrokerProtocolError",
        });
        expect(JSON.stringify(failure)).not.toContain(privateText);
        expect((failure as Error).cause).toBeUndefined();
    });

    test("encode accepts the two reviewed message families only at typed call sites", () => {
        const request: DockerBrokerRequest = parseDockerBrokerRequest(logsRequest);
        const response: DockerBrokerResponse = parseDockerBrokerResponse(logsResponse);
        expect(decodeSingle(encodeDockerBrokerFrame(request))).toEqual(request);
        expect(decodeSingle(encodeDockerBrokerFrame(response))).toEqual(response);
    });
});
