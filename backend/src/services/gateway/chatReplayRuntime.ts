import type { ChatRuntimeMetrics } from "../../../../contracts/metrics.ts";
import { OpenClawChatBridge } from "../chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "../chat/openClawChatSnapshotStore.ts";

interface GatewayChatReplayRuntimeOptions {
    broadcast: (message: unknown) => void;
    readGatewayConnected: () => boolean;
}

/** Owns replay scope selection and the active chat bridge generation. */
export class GatewayChatReplayRuntime {
    readonly #options: GatewayChatReplayRuntimeOptions;
    #bridge: OpenClawChatBridge;
    #generation = Bun.randomUUIDv7();
    #scope: string | undefined;

    constructor(options: GatewayChatReplayRuntimeOptions) {
        this.#options = options;
        this.#bridge = this.#createBridge();
    }

    get bridge(): OpenClawChatBridge {
        return this.#bridge;
    }

    get scope(): string | undefined {
        return this.#scope;
    }

    snapshot(sessionKey: string): Record<string, unknown> {
        return {
            ...this.#bridge.snapshot(sessionKey),
            replayScope: this.#scope,
            runtimeGeneration: this.#generation,
        };
    }

    metrics(): ChatRuntimeMetrics {
        return this.#bridge.getMetrics();
    }

    selectScope(endpoint: string, token: string): boolean {
        const gatewayScope = this.#gatewayScope(endpoint, token);
        if (gatewayScope === this.#scope) {
            this.#bridge.hydratePersistedSessions();
            return true;
        }
        if (!this.#bridge.clearMemory()) {
            return false;
        }
        this.#bridge = this.#createBridge(
            new SqliteOpenClawChatSnapshotStore(gatewayScope),
            false
        );
        this.#scope = gatewayScope;
        this.#generation = Bun.randomUUIDv7();
        this.#bridge.hydratePersistedSessions();
        return true;
    }

    #createBridge(
        store?: SqliteOpenClawChatSnapshotStore,
        gatewayConnected = this.#options.readGatewayConnected()
    ): OpenClawChatBridge {
        const bridge = new OpenClawChatBridge(store, {
            gatewayConnected,
            onDeferredEnvelope: (envelope) => {
                if (this.#bridge === bridge) {
                    this.#options.broadcast(envelope);
                }
            },
        });
        return bridge;
    }

    #gatewayScope(endpoint: string, token: string): string {
        const credentialFingerprint = new Bun.CryptoHasher("sha256")
            .update(token)
            .digest("hex");
        return new Bun.CryptoHasher("sha256")
            .update("mira-dashboard:openclaw-chat-replay:v1\0")
            .update(endpoint.trim())
            .update("\0")
            .update(credentialFingerprint)
            .digest("hex");
    }
}
