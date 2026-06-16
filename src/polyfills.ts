// Polyfill crypto.randomUUID for browsers that don't support it
// Must be imported before anything that uses crypto

if (!Uint8Array.fromBase64) {
    Uint8Array.fromBase64 = (base64: string) => {
        // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- This polyfills Uint8Array.fromBase64.
        const binary = atob(base64);
        return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    };
}

if (!Uint8Array.prototype.toBase64) {
    Uint8Array.prototype.toBase64 = function toBase64() {
        // eslint-disable-next-line unicorn/no-this-assignment, @typescript-eslint/no-this-alias, unicorn/no-this-outside-of-class -- This defines Uint8Array.prototype.toBase64.
        const bytes = this;
        const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
        // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- This polyfills Uint8Array#toBase64.
        return btoa(binary);
    };
}

(() => {
    if (
        typeof window !== "undefined" &&
        typeof window.crypto?.randomUUID === "function"
    ) {
        return;
    }

    /** Performs generate UUID. */
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
