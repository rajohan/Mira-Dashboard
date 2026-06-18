/** Installs crypto.randomUUID for browsers that do not support it. */
export function installRandomUUIDPolyfill(): void {
    if (
        typeof window !== "undefined" &&
        typeof window.crypto?.randomUUID === "function"
    ) {
        return;
    }

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
}
