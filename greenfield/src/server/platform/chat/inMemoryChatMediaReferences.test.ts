import { describe, expect, test } from "bun:test";

import {
    chatMediaAttachmentMatchesSession,
    createInMemoryChatMediaReferences,
} from "./inMemoryChatMediaReferences.ts";

const attachmentId = "00000000-0000-4000-8000-000000000001";
const reference = {
    attachmentId,
    messageId: "message-1",
    sessionKey: "agent:main:main",
};
const localMediaRoot = "/srv/openclaw/media";

describe("in-memory chat media references", () => {
    test("returns an expired association once for authoritative revalidation", () => {
        const now = { value: 1000 };
        const references = createInMemoryChatMediaReferences({
            nowMs: () => now.value,
            ttlMs: 1000,
        });
        references.register(reference);

        now.value = 2000;
        expect(references.resolve(attachmentId)).toEqual({
            ...reference,
            source: {
                kind: "gateway-managed",
                upstreamAttachmentId: attachmentId,
            },
        });
        expect(references.resolve(attachmentId)).toBeUndefined();
        references.dispose();
    });

    test("normalizes local candidates into stable path-free UUID references", () => {
        const references = createInMemoryChatMediaReferences({ localMediaRoot });
        const relative = references.registerLocal({
            candidate: "images/report final.png",
            messageId: "message-1",
            sessionKey: "agent:main:main",
            sourceSlot: "structured:0",
        });
        const absolute = references.registerLocal({
            candidate: "/srv/openclaw/media/images/report final.png",
            messageId: "message-1",
            sessionKey: "agent:main:main",
            sourceSlot: "structured:0",
        });
        const fileUrl = references.registerLocal({
            candidate: "file://localhost/srv/openclaw/media/images/report%20final.png",
            messageId: "message-1",
            sessionKey: "agent:main:main",
            sourceSlot: "structured:0",
        });
        const inbound = references.registerLocal({
            candidate: "media://inbound/b2ea3e92-1844-42d3-a512-d0c48e560657.jpg",
            messageId: "message-inbound",
            sessionKey: "agent:main:main",
            sourceSlot: "session-message:0",
        });
        const outbound = references.registerLocal({
            candidate:
                "media://outbound/notes---04f0d34e-6407-4c26-922d-60bdd998c904.md",
            messageId: "message-outbound",
            sessionKey: "agent:main:main",
            sourceSlot: "delivery-mirror-outbound:0",
        });

        expect(relative).toEqual(absolute);
        expect(relative).toEqual(fileUrl);
        expect(relative?.attachmentId).toBe("e41399fe-2747-465e-955a-c7ef3f592708");
        expect(relative?.attachmentId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        );
        expect(relative?.fileName).toBe("report final.png");
        expect(
            chatMediaAttachmentMatchesSession(relative!.attachmentId, "agent:main:main")
        ).toBeTrue();
        expect(
            chatMediaAttachmentMatchesSession(relative!.attachmentId, "agent:other:main")
        ).toBeFalse();
        expect(JSON.stringify(relative)).not.toContain("/srv/openclaw");
        expect(references.resolve(inbound!.attachmentId)?.source).toEqual({
            kind: "openclaw-local-history",
            segments: ["inbound", "b2ea3e92-1844-42d3-a512-d0c48e560657.jpg"],
        });
        expect(references.resolve(outbound!.attachmentId)?.source).toEqual({
            kind: "openclaw-local-history",
            segments: [
                "outbound",
                "notes---04f0d34e-6407-4c26-922d-60bdd998c904.md",
            ],
        });
        expect(references.resolve(relative!.attachmentId)).toEqual({
            attachmentId: relative!.attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
            source: {
                kind: "openclaw-local-history",
                segments: ["images", "report final.png"],
            },
        });
        references.dispose();
    });

    test("wraps managed ids in stable session-routable references", () => {
        const first = createInMemoryChatMediaReferences();
        const second = createInMemoryChatMediaReferences();
        const input = {
            attachmentId,
            messageId: "message-managed",
            sessionKey: "agent:target:main",
        };

        const registered = first.registerManaged(input);
        const restarted = second.registerManaged(input);

        expect(registered).toEqual(restarted);
        expect(registered.attachmentId).not.toBe(attachmentId);
        expect(
            chatMediaAttachmentMatchesSession(registered.attachmentId, input.sessionKey)
        ).toBeTrue();
        expect(
            chatMediaAttachmentMatchesSession(
                registered.attachmentId,
                "agent:unrelated:main"
            )
        ).toBeFalse();
        expect(first.resolve(registered.attachmentId)).toEqual({
            attachmentId: registered.attachmentId,
            messageId: input.messageId,
            sessionKey: input.sessionKey,
            source: {
                kind: "gateway-managed",
                upstreamAttachmentId: attachmentId,
            },
        });
        expect(first.resolve(attachmentId)).toEqual({
            attachmentId,
            authorizationAttachmentId: registered.attachmentId,
            messageId: input.messageId,
            sessionKey: input.sessionKey,
            source: {
                kind: "gateway-managed",
                upstreamAttachmentId: attachmentId,
            },
        });
        first.dispose();
        second.dispose();
    });

    test("accounts compatibility aliases without reducing managed-media capacity", () => {
        const references = createInMemoryChatMediaReferences({ maximumReferences: 4 });
        const first = references.registerManaged({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:first:main",
        });
        const secondUpstreamId = "00000000-0000-4000-8000-000000000002";
        const second = references.registerManaged({
            attachmentId: secondUpstreamId,
            messageId: "message-2",
            sessionKey: "agent:second:main",
        });

        expect(references.resolve(first.attachmentId)?.messageId).toBe("message-1");
        expect(references.resolve(attachmentId)?.messageId).toBe("message-1");
        expect(references.resolve(second.attachmentId)?.messageId).toBe("message-2");
        expect(references.resolve(secondUpstreamId)?.messageId).toBe("message-2");
        references.dispose();
    });

    test("binds local identifiers to the session, message, source slot, and locator", () => {
        const references = createInMemoryChatMediaReferences({ localMediaRoot });
        const input = {
            candidate: "images/result.png",
            messageId: "message-1",
            sessionKey: "agent:main:main",
            sourceSlot: "structured:0",
        };
        const ids = [
            references.registerLocal(input)!.attachmentId,
            references.registerLocal({ ...input, sessionKey: "agent:other:main" })!
                .attachmentId,
            references.registerLocal({ ...input, messageId: "message-2" })!.attachmentId,
            references.registerLocal({ ...input, sourceSlot: "structured:1" })!
                .attachmentId,
            references.registerLocal({ ...input, candidate: "images/other.png" })!
                .attachmentId,
        ];

        expect(new Set(ids).size).toBe(ids.length);
        references.dispose();
    });

    test("rejects remote, API, network, traversal, and outside-root candidates", () => {
        const references = createInMemoryChatMediaReferences({ localMediaRoot });
        const candidates = [
            "https://example.test/file.png",
            "data:image/png;base64,AAAA",
            "/api/media?path=/srv/openclaw/media/file.png",
            "//server/share/file.png",
            String.raw`\\server\share\file.png`,
            "../secrets.json",
            "images/../secrets.json",
            "/srv/openclaw/openclaw.json",
            "file://remotehost/srv/openclaw/media/file.png",
            "file:///srv/openclaw/media/../openclaw.json",
            "file:///srv/openclaw/media/images%5Cescaped.png",
            "media://outbound/notes.md",
            "media://outbound/../notes---04f0d34e-6407-4c26-922d-60bdd998c904.md",
        ];

        for (const candidate of candidates) {
            expect(
                references.registerLocal({
                    candidate,
                    messageId: "message-1",
                    sessionKey: "agent:main:main",
                    sourceSlot: "structured:0",
                })
            ).toBeUndefined();
        }
        references.dispose();
    });

    test("fails closed when an attachment association changes", () => {
        const references = createInMemoryChatMediaReferences();
        references.register(reference);

        expect(() =>
            references.register({ ...reference, messageId: "message-2" })
        ).toThrow("Chat media reference association changed");
        expect(references.resolve(attachmentId)).toBeUndefined();
        references.dispose();

        const changedSource = createInMemoryChatMediaReferences();
        changedSource.register(reference);
        expect(() =>
            changedSource.register({
                ...reference,
                source: {
                    kind: "openclaw-local-history",
                    segments: ["images", "different.png"],
                },
            })
        ).toThrow("Chat media reference association changed");
        expect(changedSource.resolve(attachmentId)).toBeUndefined();
        changedSource.dispose();
    });

    test("evicts the oldest reference and makes disposal terminal", () => {
        const references = createInMemoryChatMediaReferences({ maximumReferences: 1 });
        references.register(reference);
        references.register({
            ...reference,
            attachmentId: "00000000-0000-4000-8000-000000000002",
        });

        expect(references.resolve(attachmentId)).toBeUndefined();
        references.dispose();
        expect(
            references.resolve("00000000-0000-4000-8000-000000000002")
        ).toBeUndefined();
        expect(() => references.register(reference)).toThrow(
            "Chat media references are disposed"
        );
    });
});
