import { type RefObject, useEffect, useEffectEvent, useRef } from "react";

import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";
import { LoadingState } from "./LoadingState.tsx";

export interface InfiniteScrollContinuation {
    readonly error?: string;
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly loadingLabel: string;
    readonly onLoadMore: () => void;
}

interface InfiniteScrollTriggerProps extends InfiniteScrollContinuation {
    readonly className?: string;
    readonly rootRef?: RefObject<HTMLElement | null>;
}

/** @returns An automatic continuation boundary with loading and retry feedback. */
export function InfiniteScrollTrigger({
    className,
    error,
    hasMore,
    loading,
    loadingLabel,
    onLoadMore,
    rootRef,
}: InfiniteScrollTriggerProps) {
    const sentinelRef = useRef<HTMLDivElement>(null);
    const loadMore = useEffectEvent(onLoadMore);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (
            sentinel === null ||
            !hasMore ||
            loading ||
            error !== undefined ||
            globalThis.IntersectionObserver === undefined
        ) {
            return;
        }
        let requested = false;
        const observer = new globalThis.IntersectionObserver(
            (entries) => {
                if (requested || !entries.some(({ isIntersecting }) => isIntersecting)) {
                    return;
                }
                requested = true;
                loadMore();
            },
            {
                root: rootRef?.current,
                rootMargin: "400px 0px",
            }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [error, hasMore, loading, rootRef]);

    if (!hasMore && error === undefined) return null;

    return (
        <div className={className} data-infinite-scroll-trigger ref={sentinelRef}>
            {loading && <LoadingState label={loadingLabel} size="sm" />}
            {error !== undefined && (
                <Alert
                    action={
                        <Button onClick={onLoadMore} size="sm" variant="secondary">
                            Try again
                        </Button>
                    }
                    focusOnError={false}
                    message={error}
                />
            )}
        </div>
    );
}
