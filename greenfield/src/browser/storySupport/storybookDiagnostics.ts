const scopedConsoleErrorWaivers: Readonly<Record<string, string>> = Object.freeze({
    "jobs-scheduleeditor--interval-to-daily-transition":
        "flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering. Consider moving this call to a scheduler task or micro task.",
    "tasks-taskboard--busy": "useInsertionEffect must not schedule updates.",
});

const deferredResizeObserverStories = new Set(["ui-combobox--large-virtualized"]);

function installConsoleErrorWaiver(storyId: string): () => void {
    const ignoredMessage = scopedConsoleErrorWaivers[storyId];
    if (ignoredMessage === undefined) return () => {};

    const originalConsoleError = console.error;
    const scopedConsoleError: typeof console.error = (...arguments_) => {
        const messages = arguments_.map((argument) =>
            argument instanceof Error ? argument.message : String(argument)
        );
        if (messages.includes(ignoredMessage)) return;
        originalConsoleError(...arguments_);
    };
    console.error = scopedConsoleError;

    return () => {
        if (console.error === scopedConsoleError) console.error = originalConsoleError;
    };
}

function installDeferredResizeObserver(storyId: string): () => void {
    if (!deferredResizeObserverStories.has(storyId)) return () => {};

    const OriginalResizeObserver = window.ResizeObserver;
    class DeferredResizeObserver implements ResizeObserver {
        readonly #observer: ResizeObserver;
        readonly #scheduledFrames = new Set<number>();

        constructor(callback: ResizeObserverCallback) {
            this.#observer = new OriginalResizeObserver((entries) => {
                const frame = window.requestAnimationFrame(() => {
                    this.#scheduledFrames.delete(frame);
                    callback(entries, this);
                });
                this.#scheduledFrames.add(frame);
            });
        }

        disconnect(): void {
            this.#observer.disconnect();
            for (const frame of this.#scheduledFrames) {
                window.cancelAnimationFrame(frame);
            }
            this.#scheduledFrames.clear();
        }

        observe(target: Element, options?: ResizeObserverOptions): void {
            this.#observer.observe(target, options);
        }

        unobserve(target: Element): void {
            this.#observer.unobserve(target);
        }
    }

    window.ResizeObserver = DeferredResizeObserver;
    return () => {
        if (window.ResizeObserver === DeferredResizeObserver) {
            window.ResizeObserver = OriginalResizeObserver;
        }
    };
}

/**
 * Installs narrowly scoped workarounds for diagnostics from pinned prerelease UI packages.
 * @param storyId Storybook's stable story identifier.
 * @returns Cleanup that restores browser globals after the story finishes.
 */
export function installPinnedStorybookDiagnosticWorkarounds(storyId: string): () => void {
    const restoreConsoleError = installConsoleErrorWaiver(storyId);
    const restoreResizeObserver = installDeferredResizeObserver(storyId);

    return () => {
        restoreResizeObserver();
        restoreConsoleError();
    };
}
