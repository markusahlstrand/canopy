/**
 * A dependency-free client for the a3doc WebAPI (Wolters Kluwer's a3ASESOR doc), the document
 * system Spanish gestorías share with their clients. It imports nothing, so any host can use it;
 * the Substrat connector built on it is `./files`.
 *
 * The API is the one a3doc's own web app (a3doc.wolterskluwer.es) speaks: every call is a JSON
 * `POST <apiBase>/<Method>` whose body carries a session `token`, and every answer is HTTP 200
 * with an `errorCode` (0 = ok). API failures are read from the body; transport failures are
 * checked separately. The token comes from `signIn` (company code + user + password).
 *
 * Methods the web app uses, and so the whole surface there is: `signIn`, `UserInfo`,
 * `ContainersTree`, `RootContainer`, `GetDocumentsExtended`, `Download`, `Upload`,
 * `GetCustomersListExtended`, `Logout`. There is **no delete, rename, move, or create-folder**:
 * a3doc's clients can add documents but never take them away.
 */

/** Where the web app looks up a company's API endpoint (`/v1/Address/<companyCode>`). */
export const A3DOC_ADDRESS_PROVIDER = "https://a3asesordoc-serviceaddressprovider.a3software.com";
/** The id of the root container ("Todos"). */
export const A3DOC_ROOT_CONTAINER = 1;
/** `errorCode` a3doc answers with when the session token is unknown or expired. */
export const TOKEN_INVALID = 6;
/** The attribute id the web app filters on to find documents by title. */
const TITLE_ATTRIBUTE_ID = 3;

/**
 * The fetch this client needs, and nothing more. Structural on purpose: a runtime `fetch` and the
 * Substrat kernel's `FetchLike` both satisfy it, so the client stays free of either's typings.
 */
export interface A3docFetch {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    readonly status: number;
    text(): Promise<string>;
  }>;
}

export interface A3docCredentials {
  companyCode: string;
  user: string;
  password: string;
}

export interface A3docClientConfig {
  credentials: A3docCredentials;
  fetch: A3docFetch;
  /** `…/WebAPI/v1`. Resolved from the company code via the address provider when absent. */
  apiBase?: string;
  addressProvider?: string;
}

export class A3docError extends Error {
  constructor(
    readonly code: number,
    readonly method: string,
    detail?: string,
  ) {
    super(`a3doc ${method} failed: error ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "A3docError";
  }
}

/** One node of `ContainersTree`: a folder. */
export interface A3Container {
  id: number;
  name: string;
  parentId?: number | null;
  numDocuments?: number;
  /** `null` on a leaf, not absent. */
  children?: A3Container[] | null;
}

/** One document from `GetDocumentsExtended` (PascalCase, as the API returns it). */
export interface A3Document {
  Id: string;
  /** Sequential document number: unique, so it disambiguates equal titles. */
  Code?: number;
  Title?: string;
  /** Extension WITH the leading dot, upper-case: ".PDF". */
  Type?: string;
  /** Kilobytes, rounded down. */
  Size?: number;
  /** The document's own date, `DD/MM/YYYY`. */
  Date?: string;
  /** `DD/MM/YYYY HH:MM:SS`, Spanish wall-clock time. */
  DateModified?: string;
  CustomerId?: string;
  CustomerName?: string;
  /** A document can sit in several containers at once. */
  ContainersId?: number[];
}

export interface DocumentPage {
  total: number;
  documents: A3Document[];
}

export interface UserInfo {
  name: string;
  email: string;
  userType: number;
  role: number;
}

export interface UploadInput {
  containerIds: number[];
  /** The a3doc customer (NIF/CIF) the document is filed under. */
  customerId: string;
  title: string;
  /** With or without the leading dot; sent lower-case with one, as the web app does. */
  extension: string;
  bytes: Uint8Array;
}

export interface A3docClient {
  /** Sign in now (a probe's check). Every other method signs in on its own when it needs to. */
  signIn(): Promise<void>;
  userInfo(): Promise<UserInfo>;
  containersTree(): Promise<A3Container[]>;
  listDocuments(opts: { containerId: number; children: boolean; pageIndex: number; pageSize: number }): Promise<DocumentPage>;
  /** Documents whose title is exactly `title`, in `containerId` (and below it when `children`). */
  findByTitle(opts: { containerId: number; children: boolean; title: string }): Promise<A3Document[]>;
  /** The document's bytes, or `null` when a3doc answers that it has no such document. */
  download(documentId: string): Promise<Uint8Array | null>;
  /** Adds a NEW document (a3doc never replaces one) and returns its id. */
  upload(input: UploadInput): Promise<string>;
}

/** Roles the web app hides its upload page from (`userRol` 1 and 6). */
export const canUploadAs = (role: number) => role !== 1 && role !== 6;

interface Envelope {
  errorCode: number;
  errorMessage?: string;
}

export function createA3docClient(config: A3docClientConfig): A3docClient {
  const doFetch = config.fetch;
  const { companyCode, user, password } = config.credentials;
  let apiBase = config.apiBase?.replace(/\/+$/, "") ?? null;
  let token: string | null = null;

  async function post<T>(url: string, body: unknown, what: string): Promise<T> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return readJson<T>(res, what);
  }

  async function resolveApiBase(): Promise<string> {
    if (apiBase) return apiBase;
    const provider = (config.addressProvider ?? A3DOC_ADDRESS_PROVIDER).replace(/\/+$/, "");
    const res = await doFetch(`${provider}/v1/Address/${encodeURIComponent(companyCode)}`);
    const body = await readJson<{ errorCode?: number; errorMessage?: string; URL?: string }>(res, "Address", true);
    if (!body.URL) throw new A3docError(body.errorCode ?? 0, "Address", body.errorMessage || "unknown company code");
    // The provider answers with the WebAPI root; the web app then calls `<URL>/v1/<Method>`.
    apiBase = `${body.URL.replace(/\/+$/, "")}/v1`;
    return apiBase;
  }

  async function signIn(): Promise<string> {
    const base = await resolveApiBase();
    // devicePlatform 13 / deviceType 0 is what the browser build sends.
    const body = await post<Envelope & { token?: string }>(
      `${base}/signIn`,
      { devicePlatform: 13, deviceType: 0, tenant: companyCode, user, password, deviceId: "canopy-a3docs-connector" },
      "signIn",
    );
    if (!body.token) throw new A3docError(body.errorCode ?? 0, "signIn", body.errorMessage);
    token = body.token;
    return token;
  }

  /** POST one method; sign in first when there is no token, and once more when it expired. */
  async function call<T extends Envelope>(method: string, params: Record<string, unknown>): Promise<T> {
    const base = await resolveApiBase();
    const run = (t: string) => post<T>(`${base}/${method}`, { ...params, token: t }, method);
    let body = await run(token ?? (await signIn()));
    if (body.errorCode === TOKEN_INVALID) body = await run(await signIn());
    return body;
  }

  /** `call`, refusing any non-zero `errorCode`. */
  async function ok<T extends Envelope>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = await call<T>(method, params);
    if (body.errorCode) throw new A3docError(body.errorCode, method, body.errorMessage);
    return body;
  }

  const listParams = (containerId: number, children: boolean, pageIndex: number, pageSize: number, filter: unknown[] = []) => ({
    containersIdsToIgnore: [],
    containersIdsToSearch: [containerId],
    filter,
    pageIndex,
    pageSize,
    searchChildContainers: children,
    Order: "dateModified",
    Sort: "desc",
  });

  return {
    async signIn() {
      await signIn();
    },

    async userInfo() {
      const b = await ok<Envelope & { completeUserName?: string; mailAddress?: string; userType?: string; userRol?: string }>(
        "UserInfo",
        {},
      );
      return { name: b.completeUserName ?? "", email: b.mailAddress ?? "", userType: Number(b.userType), role: Number(b.userRol) };
    },

    async containersTree() {
      return (await ok<Envelope & { tree?: A3Container[] }>("ContainersTree", {})).tree ?? [];
    },

    async listDocuments({ containerId, children, pageIndex, pageSize }) {
      const b = await ok<Envelope & { countAllDocuments?: number; documents?: A3Document[] }>(
        "GetDocumentsExtended",
        listParams(containerId, children, pageIndex, pageSize),
      );
      return { total: b.countAllDocuments ?? 0, documents: b.documents ?? [] };
    },

    async findByTitle({ containerId, children, title }) {
      const filter = [{ AttributeId: TITLE_ATTRIBUTE_ID, FilterValue: title, MatchWholeWord: true }];
      const b = await ok<Envelope & { documents?: A3Document[] }>(
        "GetDocumentsExtended",
        listParams(containerId, children, 0, 100, filter),
      );
      // The filter is the web app's search, so it may match loosely; the title is checked here.
      return (b.documents ?? []).filter((d) => (d.Title ?? "").trim() === title.trim());
    },

    async download(documentId) {
      const b = await call<Envelope & { content?: string }>("Download", { documentId });
      if (b.errorCode === TOKEN_INVALID) throw new A3docError(b.errorCode, "Download", b.errorMessage);
      // Any other refusal of a document id is a3doc answering about that document: it has none.
      if (b.errorCode || b.content == null) return null;
      return base64ToBytes(b.content);
    },

    async upload({ containerIds, customerId, title, extension, bytes }) {
      const ext = extension ? `.${extension.replace(/^\.+/, "")}`.toLowerCase() : "";
      const b = await ok<Envelope & { documentId?: string }>("Upload", {
        containersIds: containerIds,
        content: bytesToBase64(bytes),
        customerId,
        date: null,
        extension: ext,
        title,
      });
      if (!b.documentId) throw new A3docError(0, "Upload", "no document id returned");
      return b.documentId;
    },
  };
}

/**
 * Read an a3doc answer as JSON. The API always answers JSON, so a body that won't parse means we
 * never reached it (a proxy or CDN error page): say so instead of letting a raw `JSON.parse`
 * throw "Unexpected token …".
 */
async function readJson<T>(res: { status: number; text(): Promise<string> }, what: string, address = false): Promise<T> {
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`a3doc ${what}: HTTP ${res.status} "${snippet || "(empty body)"}"`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`a3doc ${what}: expected JSON but got HTTP ${res.status} "${snippet || "(empty body)"}"`);
  }
  // The separate address provider returns { URL } on success, without a WebAPI envelope.
  const addressSuccess = address && body && typeof body === "object" &&
    !("errorCode" in body) && "URL" in body && typeof body.URL === "string" && body.URL.length > 0;
  if (!addressSuccess && (!body || typeof body !== "object" || !("errorCode" in body) || typeof body.errorCode !== "number")) {
    throw new Error(`a3doc ${what}: answer has no numeric errorCode`);
  }
  return body as T;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: spreading a multi-MB array into one String.fromCharCode overflows the stack.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * a3doc dates are Spanish wall-clock strings (`DD/MM/YYYY[ HH:MM[:SS]]`) with no zone. Interpret
 * them in `timeZone` (default Europe/Madrid) and return ISO 8601 UTC, or undefined for anything
 * unrecognised.
 */
export function parseA3Date(s: string | undefined, timeZone = "Europe/Madrid"): string | undefined {
  const m = s?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const wall = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0));
  if (Number.isNaN(wall)) return undefined;
  // Two passes converge across a DST edge: the offset at the guessed instant, then at the corrected one.
  let utc = wall - zoneOffsetMs(wall, timeZone);
  utc = wall - zoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

/**
 * True when the wall-clock time `s` names happens twice in `timeZone` (the hour the clocks go
 * back). Such a time cannot say which of the two instants it was, so it is not a safe version key.
 */
export function isAmbiguousA3Date(s: string | undefined, timeZone = "Europe/Madrid"): boolean {
  const iso = parseA3Date(s, timeZone);
  if (!iso) return false;
  const t = Date.parse(iso);
  // When an instant an hour away shows the same wall clock, that wall clock names two instants.
  const wall = wallOf(t, timeZone);
  return wallOf(t - 3_600_000, timeZone) === wall || wallOf(t + 3_600_000, timeZone) === wall;
}

/** `timeZone`'s wall clock at instant `ts`, as a comparable number of milliseconds. */
function wallOf(ts: number, timeZone: string): number {
  return ts + zoneOffsetMs(ts, timeZone);
}

/** How far `timeZone`'s wall clock is ahead of UTC at instant `ts`. */
function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ts / 1000) * 1000;
}
