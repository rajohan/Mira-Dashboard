declare const __APP_COMMIT__: string;

declare module "*.css";
declare module "*.html" {
    const route: Bun.HTMLBundle;
    export default route;
}

interface ImportMetaEnvironment {
    readonly MODE: string;
    readonly PUBLIC_DASHBOARD_WS_PORT?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnvironment;
}

interface Uint8Array {
    toBase64(): string;
}

interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array<ArrayBuffer>;
}
