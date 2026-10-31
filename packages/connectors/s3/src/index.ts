/**
 * An S3-compatible bucket as a Substrat file source: the dependency-free client (`./client`, SigV4
 * over Web Crypto), the credential and its probe, and the binding, sync and write dispatch a vertical
 * registers through `defineConnectors`.
 */
export * from './sigv4.js';
export * from './client.js';
export * from './connection.js';
export * from './files.js';
export * from './vertical.js';
