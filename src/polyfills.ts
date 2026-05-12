// Polyfill crypto.randomUUID for browsers that don't support it
// Must be imported before anything that uses crypto

(() => {
    if (
        typeof window !== "undefined" &&
        typeof window.crypto?.randomUUID === "function"
    ) {
        return;
    }

    /** Handles generate uuid. */
    const generateUUID: Crypto["randomUUID"] = () => {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replaceAll(/[xy]/g, (character) => {
            const randomValue = Math.trunc(Math.random() * 16);
            const versionedValue =
                character === "x" ? randomValue : (randomValue & 0x3) | 0x8;
            return versionedValue.toString(16);
        }) as ReturnType<Crypto["randomUUID"]>;
    };

    const windowContainer = window as unknown as { crypto?: Crypto };
    if (!windowContainer.crypto) {
        windowContainer.crypto = {} as Crypto;
    }

    (windowContainer.crypto as Crypto & { randomUUID: Crypto["randomUUID"] }).randomUUID =
        generateUUID;

    const globalContainer = globalThis as typeof globalThis & { crypto?: Crypto };
    if (!globalContainer.crypto) {
        globalContainer.crypto = {} as Crypto;
    }

    (globalContainer.crypto as Crypto & { randomUUID: Crypto["randomUUID"] }).randomUUID =
        generateUUID;
})();
