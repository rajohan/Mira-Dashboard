function withHttpProtocol(httpsUrl: string): URL {
    const url = new URL(httpsUrl);
    if (url.protocol !== "https:") {
        throw new TypeError("Test HTTP URL source must use HTTPS");
    }
    url.protocol = "http:";
    return url;
}

export function httpOrigin(httpsOrigin: string): string {
    return withHttpProtocol(httpsOrigin).origin;
}

export function httpUrl(httpsUrl: string): string {
    return withHttpProtocol(httpsUrl).href;
}
