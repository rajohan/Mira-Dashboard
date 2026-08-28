import { useEffect, useState } from "react";

const monitoringFilterDelayMs = 300;

/**
 * Keeps text input responsive while bounding automatic filter requests.
 * @param value Current text field value.
 * @returns Trimmed value after the shared monitoring debounce window.
 */
export function useDebouncedFilter(value: string): string {
    const [debounced, setDebounced] = useState(value.trim());
    useEffect(() => {
        const timeout = globalThis.setTimeout(
            () => setDebounced(value.trim()),
            monitoringFilterDelayMs
        );
        return () => globalThis.clearTimeout(timeout);
    }, [value]);
    return debounced;
}
