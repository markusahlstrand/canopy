// Web-standard everywhere this runs (Node, Workers); declared here so the connector pulls in no
// platform typings, as Substrat's own connectors do. Only the members this package calls.

interface S3CryptoKey { readonly type: string }
declare const crypto: {
  subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
    importKey(format: 'raw', key: Uint8Array, algorithm: { name: 'HMAC'; hash: string }, extractable: boolean, usages: string[]): Promise<S3CryptoKey>;
    sign(algorithm: 'HMAC', key: S3CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  };
  randomUUID(): string;
};
declare class TextEncoder { encode(input: string): Uint8Array }
