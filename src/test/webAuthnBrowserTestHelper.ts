function restoreProperty(
    target: object,
    property: PropertyKey,
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(target, property, descriptor);
    } else {
        Reflect.deleteProperty(target, property);
    }
}

function installWebAuthnBrowser(): () => void {
    const publicKeyCredentialDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "PublicKeyCredential"
    );
    const credentialsDescriptor = Object.getOwnPropertyDescriptor(
        navigator,
        "credentials"
    );

    Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: class TestPublicKeyCredential {},
        writable: true,
    });
    Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: {
            create: async () => ({
                authenticatorAttachment: "cross-platform",
                getClientExtensionResults: () => ({}),
                id: "credential-browser",
                rawId: new Uint8Array([1, 2, 3]).buffer,
                response: {
                    attestationObject: new Uint8Array([4]).buffer,
                    clientDataJSON: new Uint8Array([5]).buffer,
                    getAuthenticatorData: () => new Uint8Array([6]).buffer,
                    getPublicKey: () => new Uint8Array([7]).buffer,
                    getPublicKeyAlgorithm: () => -7,
                    getTransports: () => ["usb"],
                },
                type: "public-key",
            }),
            get: async () => ({
                authenticatorAttachment: "cross-platform",
                getClientExtensionResults: () => ({}),
                id: "credential-browser",
                rawId: new Uint8Array([1, 2, 3]).buffer,
                response: {
                    authenticatorData: new Uint8Array([4]).buffer,
                    clientDataJSON: new Uint8Array([5]).buffer,
                    signature: new Uint8Array([6]).buffer,
                    userHandle: undefined,
                },
                type: "public-key",
            }),
        },
        writable: true,
    });

    return () => {
        restoreProperty(globalThis, "PublicKeyCredential", publicKeyCredentialDescriptor);
        restoreProperty(navigator, "credentials", credentialsDescriptor);
    };
}

export function createWebAuthnBrowserTestHarness(): {
    install: () => void;
    restore: () => void;
} {
    let restoreBrowser: (() => void) | undefined;
    return {
        install: () => {
            restoreBrowser?.();
            restoreBrowser = installWebAuthnBrowser();
        },
        restore: () => {
            restoreBrowser?.();
            restoreBrowser = undefined;
        },
    };
}
