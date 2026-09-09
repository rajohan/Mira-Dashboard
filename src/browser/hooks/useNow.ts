import { useEffect, useState } from "react";

/**
 * Ticking presentation clock shared by components that show elapsed-time copy.
 * Starts at mount time and re-renders the consumer on a fixed cadence so
 * relative labels stay accurate without waiting for data refetches.
 * @param intervalMs Milliseconds between clock updates.
 * @returns Current epoch milliseconds, refreshed every interval.
 */
export function useNow(intervalMs = 30_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = globalThis.setInterval(() => setNow(Date.now()), intervalMs);
        return () => globalThis.clearInterval(timer);
    }, [intervalMs]);
    return now;
}
