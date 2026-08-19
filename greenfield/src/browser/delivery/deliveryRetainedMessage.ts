/**
 * @param title Delivery read-region title.
 * @returns Shared copy for browser-retained Delivery snapshots.
 */
export function deliveryBrowserRetainedMessage(title: string): string {
    return `The latest ${title.toLowerCase()} refresh failed. Showing browser-retained data; consequential controls are disabled.`;
}
