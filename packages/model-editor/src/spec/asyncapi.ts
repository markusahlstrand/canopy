// Parse an AsyncAPI document (YAML/JSON) into the events layer of the project graph.
// We read structure only — channels, their send/receive operations, and the message
// payloads that flow over them. Message payloads referencing a named schema become
// the link back to entities; an `x-operationId` extension (or a channel address that
// matches an endpoint route) becomes the best-effort link to an HTTP endpoint.
//
// We target AsyncAPI 3.0 (top-level `channels` + `operations`, messages by ref) but
// degrade gracefully to 2.x, where operations live inline under each channel as
// `publish`/`subscribe`. The 2.x→3.x action mapping follows the application's point
// of view: `subscribe` ⇒ the app receives, `publish` ⇒ the app sends.

import yaml from "js-yaml";
import type { Diagnostic, SpecChannel, SpecChannelOp, SpecMessage } from "./graph-types";

export interface AsyncApiResult {
  isAsyncApi: boolean;
  channels: SpecChannel[];
  diagnostics: Diagnostic[];
}

const empty: AsyncApiResult = { isAsyncApi: false, channels: [], diagnostics: [] };

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** The last path segment of a local `$ref` (`#/components/schemas/Pet` ⇒ `Pet`). */
const refName = (ref: unknown): string | undefined =>
  typeof ref === "string" && ref.startsWith("#/") ? decodeURIComponent(ref.split("/").pop() ?? "") || undefined : undefined;

/** Resolve a local `$ref` to the node it points at, within this document. */
function resolveRef(doc: Record<string, any>, ref: string): any {
  if (!ref.startsWith("#/")) return undefined;
  let node: any = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, any>)[key];
  }
  return node;
}

/** Follow a `{ $ref }` wrapper one hop (or return the node as-is). */
const deref = (doc: Record<string, any>, node: any): any =>
  isObj(node) && typeof node.$ref === "string" ? resolveRef(doc, node.$ref) : node;

const readTags = (node: any): string[] | undefined => {
  const raw = Array.isArray(node?.tags) ? node.tags : Array.isArray(node?.["x-tags"]) ? node["x-tags"] : [];
  const tags = raw
    .map((t: unknown) => (typeof t === "string" ? t : isObj(t) && typeof t.name === "string" ? t.name : undefined))
    .filter((t: unknown): t is string => typeof t === "string");
  return tags.length ? tags : undefined;
};

/** Read a message node (resolving a `$ref`) into a normalised SpecMessage. */
function readMessage(doc: Record<string, any>, name: string, node: any): SpecMessage {
  const m = deref(doc, node) ?? {};
  const payload = m.payload;
  const payloadRef = refName(payload?.$ref) ?? refName(m.payload?.$ref);
  return {
    name,
    title: typeof m.title === "string" ? m.title : undefined,
    payloadRef,
    payloadType: !payloadRef && isObj(payload) ? (typeof payload.type === "string" ? payload.type : "object") : undefined,
    contentType: typeof m.contentType === "string" ? m.contentType : undefined,
    doc: typeof m.summary === "string" ? m.summary : typeof m.description === "string" ? m.description : undefined,
  };
}

/** A message name keyed off its `$ref`, a channel-local key, or its own `name`/`messageId`. */
const messageKey = (doc: Record<string, any>, fallbackKey: string, node: any): string => {
  const byRef = refName(node?.$ref);
  if (byRef) return byRef;
  const m = deref(doc, node) ?? {};
  return (typeof m.messageId === "string" && m.messageId) || (typeof m.name === "string" && m.name) || fallbackKey;
};

export function parseAsyncApi(text: string, fileName: string): AsyncApiResult {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    return { ...empty, diagnostics: [{ severity: "error", layer: "asyncapi", message: `Invalid YAML in ${fileName}: ${e instanceof Error ? e.message : "parse error"}`, file: fileName }] };
  }
  if (!isObj(doc) || !("asyncapi" in doc)) return empty;
  const d = doc;
  const diagnostics: Diagnostic[] = [];
  const major = parseInt(String(d.asyncapi), 10) || 0;

  // server name → protocol, so a channel can report what it speaks.
  const serverProtocol = new Map<string, string>();
  for (const [name, srv] of Object.entries(isObj(d.servers) ? d.servers : {})) {
    if (isObj(srv) && typeof srv.protocol === "string") serverProtocol.set(name, srv.protocol);
  }
  const allProtocols = [...new Set(serverProtocol.values())];

  const channels: SpecChannel[] = [];
  const channelByName = new Map<string, SpecChannel>();

  for (const [key, raw] of Object.entries(isObj(d.channels) ? d.channels : {})) {
    const ch = deref(d, raw);
    if (!isObj(ch)) continue;

    // Protocols: resolve the channel's `servers` refs, else fall back to every server.
    const serverRefs = Array.isArray(ch.servers) ? ch.servers : [];
    const protocols = serverRefs.length
      ? [...new Set(serverRefs.map((s: any) => serverProtocol.get(refName(s?.$ref) ?? "")).filter((p: unknown): p is string => !!p))]
      : allProtocols;

    // Messages: 3.x declares them under `channel.messages`; 2.x inlines a single
    // `message` on each publish/subscribe (collected with the operations below).
    const messages: SpecMessage[] = [];
    const messageByKey = new Map<string, SpecMessage>();
    const addMessage = (name: string, node: any) => {
      if (messageByKey.has(name)) return messageByKey.get(name)!;
      const msg = readMessage(d, name, node);
      messages.push(msg);
      messageByKey.set(name, msg);
      return msg;
    };
    // Name a channel message by its local map key — that's the identifier 3.x
    // operations reference (`#/channels/<c>/messages/<key>`), so the two line up.
    for (const [mKey, mNode] of Object.entries(isObj(ch.messages) ? ch.messages : {})) {
      addMessage(mKey, mNode);
    }

    const channel: SpecChannel = {
      id: key,
      name: key,
      address: typeof ch.address === "string" ? ch.address : key,
      doc: typeof ch.summary === "string" ? ch.summary : typeof ch.description === "string" ? ch.description : undefined,
      protocols: protocols.length ? protocols : undefined,
      operations: [],
      messages,
      refModels: [],
      operationIdHint: typeof ch["x-operationId"] === "string" ? ch["x-operationId"] : undefined,
      tags: readTags(ch),
      file: fileName,
    };

    // 2.x: operations are inline `publish`/`subscribe` blocks on the channel.
    if (major < 3) {
      for (const [verb, action] of [["subscribe", "receive"], ["publish", "send"]] as const) {
        const op = ch[verb];
        if (!isObj(op)) continue;
        const msgName = op.message ? addMessage(messageKey(d, `${key}.${verb}`, op.message), op.message).name : undefined;
        if (!channel.operationIdHint && typeof op["x-operationId"] === "string") channel.operationIdHint = op["x-operationId"];
        channel.operations.push({
          id: typeof op.operationId === "string" ? op.operationId : `${key}.${verb}`,
          action,
          doc: typeof op.summary === "string" ? op.summary : typeof op.description === "string" ? op.description : undefined,
          messages: msgName ? [msgName] : [],
        } satisfies SpecChannelOp);
      }
    }

    channels.push(channel);
    channelByName.set(key, channel);
  }

  // 3.x: operations are a top-level map, each pointing at a channel + its messages.
  if (major >= 3) {
    for (const [opId, raw] of Object.entries(isObj(d.operations) ? d.operations : {})) {
      const op = deref(d, raw);
      if (!isObj(op)) continue;
      // `channel: { $ref: '#/channels/<key>' }` — recover the channel key.
      const chName = refName(op.channel?.$ref);
      const channel = chName ? channelByName.get(chName) : undefined;
      if (!channel) continue;
      const msgNodes = Array.isArray(op.messages) ? op.messages : [];
      const msgNames = msgNodes
        .map((mn: any) => {
          // 3.x operation messages ref the channel's message: #/channels/<c>/messages/<key>
          const segs = typeof mn?.$ref === "string" ? mn.$ref.split("/") : [];
          const localKey = segs.length ? decodeURIComponent(segs[segs.length - 1]!) : undefined;
          const existing = channel.messages.find((m) => m.name === localKey);
          return existing ? existing.name : localKey;
        })
        .filter((n: unknown): n is string => typeof n === "string");
      if (!channel.operationIdHint && typeof op["x-operationId"] === "string") channel.operationIdHint = op["x-operationId"];
      channel.operations.push({
        id: opId,
        action: op.action === "send" ? "send" : "receive",
        doc: typeof op.summary === "string" ? op.summary : typeof op.description === "string" ? op.description : undefined,
        messages: msgNames,
      } satisfies SpecChannelOp);
    }
  }

  // Roll each channel's payload refs up to its `refModels` (de-duplicated).
  for (const channel of channels) {
    channel.refModels = [...new Set(channel.messages.map((m) => m.payloadRef).filter((r): r is string => !!r))];
  }

  return { isAsyncApi: true, channels, diagnostics };
}
