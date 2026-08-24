const recoveryCodeDownloadFileName = "mira-dashboard-recovery-codes.txt";

/**
 * Downloads the one-time recovery codes already held by the current browser view.
 * The generated object URL is revoked immediately after the browser accepts it.
 * @param codes One-time recovery codes to persist in the downloaded text file.
 */
export function downloadRecoveryCodes(codes: readonly string[]): void {
    const contents = [
        "Mira Dashboard recovery codes",
        "Each code can be used once. Store these offline.",
        "",
        ...codes,
        "",
    ].join("\n");
    const objectUrl = URL.createObjectURL(
        new Blob([contents], { type: "text/plain;charset=utf-8" })
    );
    try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = recoveryCodeDownloadFileName;
        anchor.click();
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}
