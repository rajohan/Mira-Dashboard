type GlobalEventListener<EventType extends Event> = (event: EventType) => void;

/**
 * Registers one global browser event and returns the matching cleanup operation.
 *
 * Keeping the pair together prevents subscriptions in effects from drifting away
 * from their corresponding removal when event names or options change.
 * @param eventName Event name value.
 * @param listener Listener value.
 * @param options Operation options.
 * @returns Subscribe to global event result.
 */
export function subscribeToGlobalEvent<EventType extends Event = Event>(
    eventName: string,
    listener: GlobalEventListener<EventType>,
    options?: boolean | AddEventListenerOptions
): () => void {
    const globalListener: EventListener = (event) => {
        listener(event as EventType);
    };
    addEventListener(eventName, globalListener, options);
    return () => {
        removeEventListener(eventName, globalListener, options);
    };
}
