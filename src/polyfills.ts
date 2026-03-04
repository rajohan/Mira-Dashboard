// Polyfill crypto.randomUUID for browsers that don't support it
// Must be imported before anything that uses crypto
(() => {
    // Check if crypto.randomUUID is already available and is a function
    if (
        typeof window !== "undefined" &&
        typeof window.crypto?.randomUUID === "function"
    ) {
        return;
    }

    // Fallback implementation
    const generateUUID = () => {
        // Generate v4 UUID
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replaceAll(/[xy]/g, (c) => {
            const r = Math.trunc(Math.random() * 16);
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    };

    // Polyfill crypto if it doesn't exist
    if (!window.crypto) {
        (window as any).crypto = {};
    }

    // Add randomUUID method
    (window.crypto as any).randomUUID = generateUUID;

    // Also add to globalThis for Node.js compatibility
    if (
        (globalThis as any).crypto === undefined ||
        typeof (globalThis as any).crypto?.randomUUID !== "function"
    ) {
        (globalThis as any).crypto = { randomUUID: generateUUID };
    }
})();
