/** Shared width and centering for normal Dashboard page content. */
export const dashboardPageContainerClassName = "mx-auto w-full max-w-7xl";

/**
 * @param pathname Resolved Dashboard route pathname.
 * @returns Route-aware content wrapper sizing inside the scroll canvas.
 */
export function dashboardContentContainerClassName(pathname: string): string {
    if (pathname === "/chat" || pathname === "/terminal") {
        return "h-full min-h-0 w-full";
    }
    if (pathname === "/files") {
        return `h-full min-h-0 ${dashboardPageContainerClassName}`;
    }
    return dashboardPageContainerClassName;
}

/**
 * Keeps full-height workspaces usable without dropping the normal page gutter.
 * @param pathname Resolved Dashboard route pathname.
 * @returns Route-aware main content classes for the persistent shell.
 */
export function dashboardMainClassName(pathname: string): string {
    if (pathname === "/chat") {
        return "min-h-0 flex-1 overflow-hidden p-2 sm:p-3";
    }
    if (pathname === "/terminal") {
        return "min-h-0 flex-1 overflow-hidden px-4 pt-8 pb-3 sm:px-6 lg:px-8";
    }
    if (pathname === "/files") {
        return "min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6 lg:overflow-hidden lg:px-8";
    }
    return "min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6 lg:px-8";
}
