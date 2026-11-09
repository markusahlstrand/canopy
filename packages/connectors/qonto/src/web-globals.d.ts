// Web-standard everywhere this runs (Node, Workers); declared here so the connector pulls in no
// platform typings, as Substrat's own connectors do. Only the members this package calls.

declare class TextEncoder { encode(input: string): Uint8Array }
