declare const __APP_COMMIT__: string;

declare module "*.css";

interface Uint8Array {
    toBase64(): string;
}

interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array<ArrayBuffer>;
}
