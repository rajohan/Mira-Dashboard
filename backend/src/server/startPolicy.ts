export function shouldStartScheduledJobs(
    environment: Record<string, string | undefined> = process.env
): boolean {
    return environment.NODE_ENV !== "production";
}
