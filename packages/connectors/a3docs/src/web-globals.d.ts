// Web-standard everywhere this runs (Node, Workers); declared here so the connector pulls in no
// platform typings, as Substrat's own connectors do. Only the members this package calls.

declare const crypto: {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
  randomUUID(): string;
};
declare function btoa(data: string): string;
declare function atob(data: string): string;
