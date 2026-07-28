const LAZY_IMPORT_RELOAD_COOLDOWN_MS = 60_000;
const LAZY_IMPORT_RELOAD_KEY_PREFIX = "mira-dashboard:lazy-import-reload:";

interface RecoveryStorage {
    getItem(key: string): string | null | undefined;
    removeItem(key: string): void;
    setItem(key: string, value: string): void;
}

interface LazyImportRecoveryOptions {
    now?: () => number;
    reload?: () => void;
    storage?: RecoveryStorage;
}

const reloadAttempts = new Map<string, number>();

function browserSessionStorage(): RecoveryStorage | undefined {
    try {
        return sessionStorage;
    } catch {
        return undefined;
    }
}

function storedReloadAt(
    storage: RecoveryStorage | undefined,
    storageKey: string
): number | undefined {
    try {
        const value = storage?.getItem(storageKey);
        if (!value) return undefined;
        const timestamp = Number(value);
        return Number.isFinite(timestamp) ? timestamp : undefined;
    } catch {
        return undefined;
    }
}

function clearReloadAttempt(
    storage: RecoveryStorage | undefined,
    storageKey: string
): void {
    reloadAttempts.delete(storageKey);
    try {
        storage?.removeItem(storageKey);
    } catch {
        // The in-memory guard still prevents a reload loop in this page.
    }
}

function recordReloadAttempt(
    storage: RecoveryStorage | undefined,
    storageKey: string,
    timestamp: number
): void {
    reloadAttempts.set(storageKey, timestamp);
    try {
        storage?.setItem(storageKey, String(timestamp));
    } catch {
        // The in-memory guard still protects the current page.
    }
}

/**
 * Reloads an already-open tab once when a deployment removes a lazy chunk
 * referenced by its previous entry bundle.
 */
export async function loadLazyModule<T>(
    moduleKey: string,
    load: () => Promise<T>,
    options: LazyImportRecoveryOptions = {}
): Promise<T> {
    const storage =
        options.storage === undefined ? browserSessionStorage() : options.storage;
    const storageKey = `${LAZY_IMPORT_RELOAD_KEY_PREFIX}${moduleKey}`;

    try {
        const loaded = await load();
        clearReloadAttempt(storage ?? undefined, storageKey);
        return loaded;
    } catch (error) {
        const now = (options.now ?? Date.now)();
        const lastReloadAt =
            storedReloadAt(storage ?? undefined, storageKey) ??
            reloadAttempts.get(storageKey);
        const elapsedSinceReload =
            lastReloadAt === undefined ? undefined : now - lastReloadAt;
        if (
            elapsedSinceReload !== undefined &&
            elapsedSinceReload >= 0 &&
            elapsedSinceReload < LAZY_IMPORT_RELOAD_COOLDOWN_MS
        ) {
            throw error;
        }

        recordReloadAttempt(storage ?? undefined, storageKey, now);
        try {
            (options.reload ?? (() => location.reload()))();
        } catch {
            throw error;
        }

        return await new Promise<T>(() => {
            // Navigation replaces this document; keep Suspense pending meanwhile.
        });
    }
}
