import { gatewaySessionAgentId } from "../../../contracts/gatewaySessions.ts";
import type {
    ChatEventProvider,
    ChatEventSubscription,
    ChatProviderEvent,
    ChatProviderEventGap,
    ChatProviderReconciliationReason,
    ChatProviderRunWatermark,
} from "./provider.ts";

export const chatSessionSubscriptionMaximum = 64;
export const chatSessionSubscriptionIdleMilliseconds = 30_000;

export class ChatSubscriptionCapacityError extends Error {
    public constructor() {
        super("Chat session subscription capacity is full");
        this.name = "ChatSubscriptionCapacityError";
    }
}

export interface ChatSessionSubscriptionManagerOptions {
    readonly idleMilliseconds?: number;
    readonly isPinned: (sessionKey: string) => boolean;
    readonly maximum?: number;
    readonly nowMs?: () => number;
    readonly onEvent: (event: ChatProviderEvent) => void | Promise<void>;
    readonly onGap: (gap: ChatProviderEventGap) => void | Promise<void>;
    readonly onReconciliationRequired: (
        sessionKey: string,
        reason: ChatProviderReconciliationReason
    ) => void | Promise<void>;
    readonly provider: ChatEventProvider;
    readonly watermarks: (sessionKey: string) => readonly ChatProviderRunWatermark[];
}

interface SubscriptionLease {
    lastTouchedAtMs: number;
    opening?: Promise<ChatEventSubscription>;
    subscription?: ChatEventSubscription;
}

/**
 * Bounded process-owned session subscription leases shared by every tab and
 * retained briefly across polling, selected-session switches, and reconnects.
 */
export class ChatSessionSubscriptionManager {
    readonly #idleMilliseconds: number;
    readonly #isPinned: (sessionKey: string) => boolean;
    readonly #leases = new Map<string, SubscriptionLease>();
    readonly #maximum: number;
    readonly #nowMs: () => number;
    readonly #onEvent: (event: ChatProviderEvent) => void | Promise<void>;
    readonly #onGap: (gap: ChatProviderEventGap) => void | Promise<void>;
    readonly #onReconciliationRequired: (
        sessionKey: string,
        reason: ChatProviderReconciliationReason
    ) => void | Promise<void>;
    readonly #provider: ChatEventProvider;
    readonly #watermarks: (sessionKey: string) => readonly ChatProviderRunWatermark[];
    #disposed = false;

    public constructor(options: ChatSessionSubscriptionManagerOptions) {
        this.#idleMilliseconds =
            options.idleMilliseconds ?? chatSessionSubscriptionIdleMilliseconds;
        this.#isPinned = options.isPinned;
        this.#maximum = options.maximum ?? chatSessionSubscriptionMaximum;
        this.#nowMs = options.nowMs ?? Date.now;
        this.#onEvent = options.onEvent;
        this.#onGap = options.onGap;
        this.#onReconciliationRequired = options.onReconciliationRequired;
        this.#provider = options.provider;
        this.#watermarks = options.watermarks;
        if (
            !Number.isSafeInteger(this.#idleMilliseconds) ||
            this.#idleMilliseconds < 1 ||
            !Number.isSafeInteger(this.#maximum) ||
            this.#maximum < 1 ||
            this.#maximum > chatSessionSubscriptionMaximum
        ) {
            throw new RangeError("Chat subscription lease policy is invalid");
        }
    }

    public get size(): number {
        return this.#leases.size;
    }

    async #closeLease(sessionKey: string, lease: SubscriptionLease): Promise<void> {
        if (this.#leases.get(sessionKey) !== lease) return;
        this.#leases.delete(sessionKey);
        const subscription = lease.subscription ?? (await lease.opening?.catch(() => {}));
        await subscription?.close();
    }

    async #rotateAfterTerminalBoundary(
        sessionKey: string,
        lease: SubscriptionLease
    ): Promise<void> {
        if (this.#leases.get(sessionKey) !== lease) return;
        this.#leases.delete(sessionKey);
        if (lease.subscription !== undefined) {
            await lease.subscription.close();
        } else if (lease.opening !== undefined) {
            // A provider may report a replay boundary before subscribeChat resolves.
            // Do not await that opening from inside its own callback.
            void lease.opening
                .then((subscription) => subscription.close())
                .catch(() => {});
        }
        if (!this.#disposed && this.#isPinned(sessionKey)) {
            await this.touch(sessionKey);
        }
    }

    public async invalidate(sessionKey: string): Promise<boolean> {
        const lease = this.#leases.get(sessionKey);
        if (lease === undefined) return false;
        await this.#closeLease(sessionKey, lease);
        return true;
    }

    /**
     * Releases one lease immediately once no durable run pins its session.
     * @param sessionKey Canonical Gateway session key.
     * @returns Whether an unpinned lease was released.
     */
    public async releaseIfUnpinned(sessionKey: string): Promise<boolean> {
        if (this.#isPinned(sessionKey)) return false;
        return this.invalidate(sessionKey);
    }

    public async sweep(atMs = this.#nowMs()): Promise<number> {
        const expired = [...this.#leases.entries()].filter(
            ([sessionKey, lease]) =>
                !this.#isPinned(sessionKey) &&
                atMs - lease.lastTouchedAtMs >= this.#idleMilliseconds
        );
        await Promise.all(
            expired.map(([sessionKey, lease]) => this.#closeLease(sessionKey, lease))
        );
        return expired.length;
    }

    public async touch(sessionKey: string): Promise<void> {
        if (this.#disposed) throw new Error("Chat subscription manager is disposed");
        const now = this.#nowMs();
        const current = this.#leases.get(sessionKey);
        if (current !== undefined) {
            current.lastTouchedAtMs = now;
            await current.opening;
            return;
        }
        await this.sweep(now);
        if (this.#leases.size >= this.#maximum) {
            throw new ChatSubscriptionCapacityError();
        }
        const agentId =
            sessionKey === "main" || sessionKey === "global"
                ? "main"
                : gatewaySessionAgentId(sessionKey);
        if (agentId === undefined) {
            throw new TypeError("Chat subscription requires a canonical session owner");
        }
        const lease: SubscriptionLease = { lastTouchedAtMs: now };
        this.#leases.set(sessionKey, lease);
        const opening = this.#provider.subscribeChat({
            agentId,
            onEvent: async (event) => {
                if (this.#disposed || this.#leases.get(sessionKey) !== lease) {
                    return;
                }
                await this.#onEvent(event);
            },
            onGap: async (gap) => {
                if (this.#disposed || this.#leases.get(sessionKey) !== lease) {
                    return;
                }
                await this.#onGap(gap);
            },
            onReconciliationRequired: async (reason) => {
                if (this.#disposed || this.#leases.get(sessionKey) !== lease) {
                    return;
                }
                try {
                    await this.#onReconciliationRequired(sessionKey, reason);
                } finally {
                    // The provider listener is terminal even when canonical
                    // reconciliation fails. Never retain a zombie lease: pinned
                    // work must reacquire immediately, while unpinned work waits
                    // for the next explicit touch.
                    await this.#rotateAfterTerminalBoundary(sessionKey, lease);
                }
            },
            runWatermarks: this.#watermarks(sessionKey),
            sessionKey,
        });
        lease.opening = opening;
        try {
            const subscription = await opening;
            if (this.#disposed || this.#leases.get(sessionKey) !== lease) {
                await subscription.close();
                return;
            }
            lease.subscription = subscription;
        } catch (error) {
            if (this.#leases.get(sessionKey) === lease) {
                this.#leases.delete(sessionKey);
            }
            throw error;
        } finally {
            lease.opening = undefined;
        }
    }

    public async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        const leases = [...this.#leases.entries()];
        await Promise.all(
            leases.map(([sessionKey, lease]) => this.#closeLease(sessionKey, lease))
        );
    }
}
