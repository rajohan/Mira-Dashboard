export interface DashboardSocket {
    close(code?: number, reason?: string): void;
    isOpen(): boolean;
    onClose(handler: () => void): void;
    onError(handler: (error: unknown) => void): void;
    onMessage(handler: (data: string | Buffer) => void): void;
    send(data: string): void;
}
