/**
 * Reveals a validated automation token before any cache refresh can delay the
 * one-time secret boundary.
 * @param token One-time token returned by the validated browser client.
 * @param revealToken Component-local secret-state writer.
 * @param refreshQueries Non-secret cache refresh started after reveal.
 */
export async function revealIssuedAutomationToken(
    token: string,
    revealToken: (token: string) => void,
    refreshQueries: () => Promise<void>
): Promise<void> {
    revealToken(token);
    await refreshQueries();
}
