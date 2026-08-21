/** A safe failure used when the process transport projection cannot be validated. */
export class GatewayConnectionUnavailableError extends Error {
    public constructor() {
        super("Gateway connection state is unavailable");
        this.name = "GatewayConnectionUnavailableError";
    }
}
