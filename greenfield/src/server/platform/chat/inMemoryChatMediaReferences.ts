import * as v from "valibot";

import { chatAttachmentIdSchema } from "../../../contracts/chatMedia.ts";
import type { PersistentGatewayChatMediaReferenceRegistrar } from "../gateway/persistentGatewayChatProvider.ts";

export const chatMediaReferenceMaximum = 2048;
export const chatMediaReferenceTtlMs = 10 * 60 * 1000;

export interface ChatMediaReference {
    readonly attachmentId: string;
    readonly messageId: string;
    readonly sessionKey: string;
}

export interface InMemoryChatMediaReferences extends PersistentGatewayChatMediaReferenceRegistrar {
    readonly dispose: () => void;
    readonly resolve: (attachmentId: string) => ChatMediaReference | undefined;
}

export interface InMemoryChatMediaReferencesOptions {
    readonly maximumReferences?: number;
    readonly nowMs?: () => number;
    readonly ttlMs?: number;
}

interface StoredReference extends ChatMediaReference {
    readonly expiresAtMs: number;
}

function boundedIdentity(value: string, maximum: number): string {
    if (
        value.length === 0 ||
        value.length > maximum ||
        value !== value.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(value)
    ) {
        throw new TypeError("Chat media reference is invalid");
    }
    return value;
}

class InMemoryChatMediaReferencesImplementation implements InMemoryChatMediaReferences {
    readonly #maximumReferences: number;
    readonly #nowMs: () => number;
    readonly #references = new Map<string, StoredReference>();
    readonly #ttlMs: number;
    #disposed = false;

    constructor(options: InMemoryChatMediaReferencesOptions) {
        this.#maximumReferences = options.maximumReferences ?? chatMediaReferenceMaximum;
        this.#nowMs = options.nowMs ?? Date.now;
        this.#ttlMs = options.ttlMs ?? chatMediaReferenceTtlMs;
        if (
            !Number.isSafeInteger(this.#maximumReferences) ||
            this.#maximumReferences < 1 ||
            !Number.isSafeInteger(this.#ttlMs) ||
            this.#ttlMs < 1000 ||
            this.#ttlMs > 60 * 60 * 1000
        ) {
            throw new TypeError("Chat media reference policy is invalid");
        }
    }

    dispose(): void {
        this.#disposed = true;
        this.#references.clear();
    }

    register(reference: ChatMediaReference): void {
        if (this.#disposed) throw new TypeError("Chat media references are disposed");
        const attachmentId = v.parse(chatAttachmentIdSchema, reference.attachmentId);
        const sessionKey = boundedIdentity(reference.sessionKey, 512);
        const messageId = boundedIdentity(reference.messageId, 256);
        const now = this.#now();
        this.#sweep(now);
        const current = this.#references.get(attachmentId);
        if (
            current !== undefined &&
            (current.sessionKey !== sessionKey || current.messageId !== messageId)
        ) {
            this.#references.delete(attachmentId);
            throw new TypeError("Chat media reference association changed");
        }
        if (current === undefined && this.#references.size >= this.#maximumReferences) {
            const oldest = this.#references.keys().next().value;
            if (oldest !== undefined) this.#references.delete(oldest);
        }
        this.#references.delete(attachmentId);
        this.#references.set(
            attachmentId,
            Object.freeze({
                attachmentId,
                expiresAtMs: now + this.#ttlMs,
                messageId,
                sessionKey,
            })
        );
    }

    resolve(attachmentId: string): ChatMediaReference | undefined {
        if (this.#disposed) return undefined;
        const parsed = v.safeParse(chatAttachmentIdSchema, attachmentId, {
            abortEarly: true,
        });
        if (!parsed.success) return undefined;
        const now = this.#now();
        this.#sweep(now);
        const reference = this.#references.get(parsed.output);
        if (reference === undefined) return undefined;
        return Object.freeze({
            attachmentId: reference.attachmentId,
            messageId: reference.messageId,
            sessionKey: reference.sessionKey,
        });
    }

    #now(): number {
        const now = this.#nowMs();
        if (!Number.isSafeInteger(now) || now < 0) {
            throw new TypeError("Chat media reference clock is invalid");
        }
        return now;
    }

    #sweep(now: number): void {
        for (const [attachmentId, reference] of this.#references) {
            if (reference.expiresAtMs <= now) this.#references.delete(attachmentId);
        }
    }
}

export function createInMemoryChatMediaReferences(
    options: InMemoryChatMediaReferencesOptions = {}
): InMemoryChatMediaReferences {
    return new InMemoryChatMediaReferencesImplementation(options);
}
