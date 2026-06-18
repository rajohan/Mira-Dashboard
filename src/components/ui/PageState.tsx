import type { ReactNode } from "react";

/** Provides props for page state. */
interface PageStateProperties {
    isLoading?: boolean;
    loading?: ReactNode;
    error?: string | undefined;
    errorView?: ReactNode;
    isEmpty?: boolean;
    empty?: ReactNode;
    children: ReactNode;
}

/** Renders the page state UI. */
export function PageState({
    isLoading = false,
    loading,
    error,
    errorView,
    isEmpty = false,
    empty,
    children,
}: PageStateProperties) {
    if (isLoading) {
        return <>{loading ?? undefined}</>;
    }

    if (error) {
        return <>{errorView ?? undefined}</>;
    }

    if (isEmpty) {
        return <>{empty ?? undefined}</>;
    }

    return <>{children}</>;
}
