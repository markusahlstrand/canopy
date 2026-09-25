/**
 * The drive as a deployable Substrat vertical — sandbox-clean and control-plane-less:
 * the shape `substrat push` deploys into the platform's dispatch namespace.
 *
 * Its only durable stores are its own DO classes: `SCOPE` (kernel + the drive module,
 * bundled — one per space), `AUTH` (the tenant's identity directory) and `SWEEPER`
 * (this deployment's own timer). No control-plane binding, no service bindings — the
 * platform refuses those, and a vertical that needed one would be asking to reach
 * outside its own tenancy.
 *
 * `substrat push` derives the deploy config from `substrat.runtimeNeeds` in
 * package.json; no wrangler config is authored for the hosted path. `wrangler.jsonc`
 * exists for local `wrangler dev` only.
 *
 * ── The auth seam ───────────────────────────────────────────────────────────────
 * One path, in every environment: the configured OIDC issuer verifies the request
 * and hands back a subject; the tenant's `IdentityDO` maps that subject to a
 * principal in THIS scope. There is deliberately no dev header — a header naming the
 * caller is an impersonation bypass one environment variable away from being live,
 * and canopy already learned that lesson on its own API.
 *
 * The issuer is per-install configuration, not code: an install points this at
 * authhero (canopy's own issuer) or at anything else that speaks OIDC.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  blobStoreBindingName,
  errorCodeOf,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  defineScopeDO,
  defineScopeSweeperDO,
  SCOPE_SWEEPER_NAME,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import { readRoutedNode, RouterAssertionError, type ScopeStub } from '@substrat-run/kernel';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import {
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  observePlace,
  placesReporter,
  reportScopeMembers,
  sha256Hex,
  type AuthProvider,
  type IdentityStub,
  type InstanceAuth,
} from '@substrat-run/vertical-auth';
import { mountApi } from '@canopy/scope-drive/routes';
import { placesFetch } from './places-fetch.js';
import { allowedOrigin } from './cors.js';
import { DRIVE_VERTICAL_ENV } from './env-spec.js';
import { MODULES, OWNER_ROLE_KEY, ROLES } from './provision.js';

/**
 * The scope-DO class = the app binary: kernel + the drive module, bundled. One
 * instance per space, and the reason a space's data is reachable only through it.
 */
export const ScopeDO = defineScopeDO(MODULES, {});

/** The tenant's identity directory: subject → principal, and the owner seat. */
export { IdentityDO };

/**
 * This deployment's own timer: a roster-keeping singleton whose alarm runs each
 * provisioned scope's due recurring work. Empty roster costs nothing, and the drive
 * will need it the moment indexing arrives.
 */
export const SweeperDO = defineScopeSweeperDO<Env>({
  versionId: (env) => env.SUBSTRAT_VERSION_ID ?? null,
  intervalMs: 120_000,
  host: hostFor,
});

export interface Env {
  SUBSTRAT_VERSION_ID?: string;
  /** One DO per scope — a space's whole database. */
  SCOPE: DurableObjectNamespace;
  /**
   * The per-tenant blob stores attachment bytes live in, bound as `BLOBS__<tenantId>`
   * — one bucket per tenant, minted in the tenant lifecycle rather than at deploy,
   * which is why this is an index signature and not a named binding.
   */
  [blobBinding: string]: unknown;
  /** Per-tenant identity directory. */
  AUTH: DurableObjectNamespace<IdentityDO>;
  /** The roster-keeping sweep singleton. */
  SWEEPER: DurableObjectNamespace;
  /** Local `wrangler dev` only: address an instance when no router asserted one. */
  ALLOW_DEV_NODE?: string;
  ROUTER_SECRET?: string;
  PLATFORM_SECRET?: string;
  /** The install's issuer. Absent ⇒ nothing authenticates, which is the honest default. */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
}

/** The sweep singleton's stub — one roster and one alarm per deployment. */
function sweeper(env: Env): DurableObjectStub & ScopeSweeperDo {
  return env.SWEEPER.get(env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME)) as DurableObjectStub &
    ScopeSweeperDo;
}

interface Node {
  tenantId: TenantId;
  scopeId: ScopeId;
}

/**
 * The local-dev node. An ADDRESS, not an identity: it says which instance an
 * un-routed request belongs to and grants nobody anything.
 */
const DEV_NODE: Node = {
  tenantId: tenantId.parse('01JZ00000000000000000DEV01'),
  scopeId: scopeId.parse('01JZ00000000000000000DEV02'),
};

function nodeFor(req: Request, env: Env): Node {
  let routed;
  try {
    routed = readRoutedNode(req.headers, {
      expectedSecret: env.ROUTER_SECRET,
      allowUnsigned: env.ALLOW_DEV_NODE === 'true',
    });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_NODE === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request' });
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    // The byte side. The vertical never names a bucket: the platform mints one per
    // tenant and attaches it under a derived name, and this resolves that name. The
    // per-SCOPE isolation inside the store is the kernel's key prefix, not ours.
    attachmentBuckets: (tid) => env[blobStoreBindingName('BLOBS', tid)] as R2Bucket | undefined,
  });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const identityDo = (env: Env, node: Node): IdentityStub =>
  env.AUTH.get(env.AUTH.idFromName(node.tenantId)) as unknown as IdentityStub;

/**
 * The provider this INSTALL's configuration selects.
 *
 * The identity choice is delivered as ONE JSON value under `substrat:auth` — issuer,
 * client id and secret, audience, cookie domain — so parsing it is the platform's job
 * and not ours: `instanceAuthFor` reads the delivered map and the tenant's DO-minted
 * session secret in a single hop, and `provider()` selects from them. Reading
 * `env.OIDC_ISSUER` directly instead is the bug this replaces — a binding is shared by
 * every install of one serving script, so it would be the same issuer for all of them
 * no matter what any tenant saved.
 *
 * A deployment-level `AUTH_PROVIDER=oidc` + `OIDC_ISSUER` remains the standalone
 * fallback, and nothing configured at all throws `AuthConfigError`, which is the honest
 * answer: a fresh install authenticates nobody until it is given an issuer.
 */
async function providerFor(env: Env, node: Node): Promise<AuthProvider> {
  return providerOf(await instanceFor(env, node));
}

/**
 * The reporter for this install, or null when it has no issuer to report to. The
 * guard above rides with it, so no call site can forget it.
 */
function reporterFor(identity: InstanceAuth['identity']) {
  return identity?.issuer ? placesReporter({ identity, fetch: placesFetch(identity.issuer) }) : null;
}

/**
 * The install's delivered identity, read once. Split from `providerFor` because two
 * callers need more than the provider: `/api/me` and the provision hook both hand
 * `instance.identity` to the places reporter, and reading the config twice would be
 * a second identity-DO round trip on the request every screen makes first.
 */
function instanceFor(env: Env, node: Node): Promise<InstanceAuth> {
  return instanceAuthFor({
    directory: identityDo(env, node),
    scopeId: node.scopeId,
    envSpec: DRIVE_VERTICAL_ENV,
    env: env as unknown as Record<string, unknown>,
  });
}

function providerOf(instance: InstanceAuth): AuthProvider {
  try {
    return instance.provider();
  } catch (e) {
    if (e instanceof AuthConfigError) throw new HTTPException(e.status, { message: e.message });
    throw e;
  }
}

/**
 * Run `work` after the response where the runtime allows it, and inline where it does
 * not. Hono's `c.executionCtx` is a getter that THROWS when there is no execution
 * context (a test harness, a direct `app.fetch`) rather than returning undefined, so
 * `if (c.executionCtx)` is not a check — it is the throw.
 */
async function defer(c: Pick<Context, 'executionCtx'>, work: Promise<unknown>): Promise<void> {
  let ctx: Context['executionCtx'] | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/** Subject → principal in this scope, or null for nobody. */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  const provider = await providerFor(env, nodeFor(req, env));
  const subject = await provider.resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * The platform's side of the contract: provision, configure, reconcile, export,
 * restore, delete. Generic — the only vertical-specific facts it needs are the role
 * table and which role an installing owner holds.
 */
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  /**
   * Two facts a new install cannot discover for itself.
   *
   * The **pending owner** is the one the platform names at provision. Without it the
   * identity DO has no subject mapping to claim on first sign-in, so the installer
   * signs in successfully and resolves to nobody — a scope only its creator should
   * reach, that its creator cannot.
   *
   * The **roster** is what this deployment's alarm walks. A scope that never joins it
   * has no retry drain and no schedules; the sweeper sits with an empty roster and
   * nothing ever arms it.
   */
  onProvision: async (env, b) => {
    const node = { tenantId: b.tenantId, scopeId: b.scopeId };
    await identityDo(env, node).setPendingOwner(b.scopeId, b.owner);
    await sweeper(env).noteScope(b.tenantId, b.scopeId);
    // The places repair (substrat#1670): the WHOLE set of logins bound in this space,
    // sent to the identity pool it signs in at, so a login's "Your places" list on the
    // issuer's own origin is right again after any report that went missing. This hook
    // also runs on `/internal/reconcile`, which is what makes it a repair rather than a
    // one-off. A no-op before the install has an issuer, and for an issuer that keeps no
    // index; it never throws.
    const { identity } = await instanceFor(env, node);
    await reportScopeMembers(identityDo(env, node), reporterFor(identity), b.scopeId);
  },
  onDeleteScope: async (env, s) => {
    await sweeper(env).forgetScope(s);
  },
  // Per-instance config delivery (the dashboard's Env and Identity tabs). WITHOUT this
  // hook `/internal/configure` answers 501 for the life of the app: the dashboard saves
  // the issuer, reports `delivered: false`, and the worker 401s on everything forever.
  onConfigure: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries),
  // Who the install belongs to, read from the directory the provision hook writes —
  // never from the role table, which says what an owner may do, not which person they are.
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  ownerSeat: (env, ref) => identityDo(env, ref).ownerSeat(ref.scopeId),
  // The recovery path once the first-sign-in window has closed. Without it an install
  // whose owner never signed in is unclaimable, and the seat stays empty forever.
  mintOwnerClaim: (env, ref, input) =>
    mintOwnerClaimLink(identityDo(env, ref), ref.scopeId, input.origin),
});

/**
 * The one door another origin may come through, and only the one an install names.
 *
 * The portal is a separate service on its own hostname — canopy serves its UI and its
 * API from one worker, and so does this vertical — so a portal reading this drive is a
 * cross-origin, credentialed request. That needs CORS, and CORS with credentials is the
 * setting most worth being strict about: it is what lets another site read this drive
 * as whoever is visiting it.
 *
 * So: the exact origin an install configured, never a wildcard (which the browser
 * refuses with credentials anyway, and which would be wrong even if it did not), and
 * nothing at all when `PORTAL_ORIGIN` is unset. `Vary: Origin` because the answer
 * depends on the request's origin and a cache must not serve one origin's answer to
 * another.
 *
 * The cookie the browser sends is the vertical's own, host-only and `SameSite=Lax` —
 * so this works only when the portal is SAME-SITE with this install (a sibling host
 * under one registrable domain). A portal on an unrelated domain gets no cookie, and
 * no amount of CORS changes that; the request simply arrives anonymous.
 */
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (!origin) return next(); // same-origin or a non-browser caller

  const configured = (await instanceFor(c.env, nodeFor(c.req.raw, c.env))).settings.PORTAL_ORIGIN;
  const allowed = allowedOrigin(origin, configured);
  if (!allowed) {
    // Not refused outright — answered WITHOUT the header, which is how CORS says no.
    // A preflight still ends here rather than reaching a route.
    return c.req.method === 'OPTIONS' ? c.body(null, 204) : next();
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'access-control-allow-origin': allowed,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': c.req.header('access-control-request-headers') ?? 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
  }

  await next();
  c.res.headers.set('access-control-allow-origin', allowed);
  c.res.headers.set('access-control-allow-credentials', 'true');
  c.res.headers.append('vary', 'Origin');
});

/**
 * The relying-party flow: login, callback, logout. This vertical runs no credential
 * store and hosts no sign-up — the issuer owns the password — but the cookie session
 * every other route reads is established HERE, and without these three routes there is
 * no way for a browser to acquire one.
 */
app.on(['GET', 'POST'], '/api/auth/*', async (c) =>
  (await providerFor(c.env, nodeFor(c.req.raw, c.env))).handle(c.req.raw),
);

/** Who am I — the first call every client makes. */
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  // One instance, read once — `principalFor` would read the config a second time for
  // the identity the places reporter needs.
  const instance = await instanceFor(c.env, node);
  const subject = await providerOf(instance).resolve(c.req.raw.headers);
  const principal = subject
    ? await identityDo(c.env, node).resolvePrincipal(node.scopeId, subject.sub)
    : null;

  // Tell the identity pool what this resolve established, after the response. Every
  // screen asks `/api/me` first, so this one call catches every way a login becomes
  // bound here — the owner's first sign-in, a claim link — and reports a signed-in
  // login bound to NOTHING as absent, which is how a stale entry drops off. Once per
  // login per isolate, and it never throws.
  if (subject) {
    await defer(c, observePlace(reporterFor(instance.identity), node.scopeId, subject.sub, principal));
  }

  return principal ? c.json({ principal: principalId.parse(principal) }) : c.json({ error: 'unauthorized' }, 401);
});

/** The claim token rides in the body, so it is never a query string. See the route below. */
const claimBody = z.object({ token: z.string().min(1) });

/**
 * Redeem an owner-claim link — the only way into an install whose first-sign-in window
 * has closed, and the missing half of a path the platform already builds.
 *
 * `mintOwnerClaim` above hands the platform a link (`/?claim=<token>`), the dashboard
 * shows it with a copy button and tells the installer to open it. Until this route, this
 * vertical never consumed it, so the link was inert and an install whose window closed
 * was unreachable — sign in, resolve to nobody, get the signed-out shell, sign in again.
 *
 * `vertical-auth` ships `claimOwner` on the directory and a mounted route for the INVITE
 * half (`mountInviteRoutes` → `/api/accept-invite`), but no shared route for the owner
 * half, so each vertical hand-rolls this one. Substrat's own demos do exactly that
 * (callout, manyfold, meridian, ticket0 each serve `POST /api/claim-owner`), and this
 * follows the same shape. substrat-run/substrat#1686 plans to move owner claims onto a
 * `become` capability; when it lands, replace this with whatever that exposes.
 *
 * The caller MUST already be signed in. A claim does not authenticate anybody — it binds
 * an already-verified subject to the pending seat, so the token decides *which* signed-in
 * subject is bound, never *that* someone is. This is also why the subject comes from the
 * provider directly and not from `principalFor`: that resolves to nobody for precisely
 * the person who needs to claim, which is the whole situation.
 */
app.post('/api/claim-owner', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const subject = await (await providerFor(c.env, node)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before claiming this space' });

  const { token } = claimBody.parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimOwner(
    node.scopeId,
    subject.sub,
    await sha256Hex(token),
  );

  // ONE answer for invalid, expired, already used, and nothing-to-claim. The directory
  // refuses to distinguish them on purpose, so a probe with a guessed token learns
  // nothing about whether this scope has a seat standing — and neither does this route.
  if (!principal) throw new HTTPException(403, { message: 'this claim link is not valid for this space' });
  return c.json({ principal: principalId.parse(principal) });
});

/**
 * The largest upload this vertical accepts, and why there is a number at all.
 *
 * The attachment surface takes bytes, not a stream — it hashes them and records the
 * length — so an upload is materialized in the isolate before it is stored. A Worker
 * isolate has 128 MB of memory for everything it is doing, and Cloudflare will hand a
 * worker a request body far larger than that (100 MB on the lower plans, more above),
 * so an unbounded read is an out-of-memory waiting for the first person who drags a
 * video in. 25 MB is a document store's honest ceiling; raising it is a decision about
 * isolate memory, not a config tweak.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Read the body, refusing anything past the cap — WITHOUT trusting `content-length`.
 *
 * The header is checked first because it turns the common case into a refusal that
 * costs nothing. It is not sufficient: it can be absent on a chunked upload and it can
 * lie, and a cap that a lying header defeats is not a cap. So the read is bounded too,
 * and stops the moment the accumulated length passes the limit rather than after.
 */
async function readBounded(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: `upload exceeds ${MAX_UPLOAD_BYTES} bytes` });
  }
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new HTTPException(413, { message: `upload exceeds ${MAX_UPLOAD_BYTES} bytes` });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * How much of a document's text the index will hold.
 *
 * There is a number because a 25 MB PDF is a lot of prose, the text lands in the
 * scope's own SQLite, and the FTS index over it is a second copy. 200k characters
 * is roughly a 400-page book — past the point where "find the document" stops
 * being the question and "find the passage" starts, which is the semantic half
 * (#57) and a different index. A document longer than this is still findable by
 * everything in its first 200k characters, and `chars` records what was kept.
 */
const MAX_INDEXED_CHARS = 200_000;

/**
 * Extract a file's text and record what came of it — INCLUDING nothing.
 *
 * Runs after the upload's response, never inside it. Extraction is slow enough to
 * notice on a large PDF and it must never be the reason a file failed to store:
 * the bytes and the version are the upload, and the text is a thing we learn
 * about them afterwards. So every path here ends in a `drive/record-text` call —
 * there is no branch that stays quiet, because "never extracted" is a state the
 * drive already has a meaning for (no row at all) and it must keep meaning that.
 *
 * PDFs only for now, deliberately. `@canopy/docworker` also parses spreadsheets,
 * but a spreadsheet's content is TABLES, and flattening a sheet into a prose blob
 * indexes a shape it does not have. DOCX has no extractor here at all. Both are
 * recorded as `unsupported` with the reason, which is exactly what that status is
 * for — and what makes adding an extractor later a visible change rather than a
 * silent one.
 */
async function extractAndRecord(
  stub: ScopeStub,
  file: { id: string; versionId: string; name: string; mime: string },
  bytes: Uint8Array,
): Promise<void> {
  const record = async (body: Record<string, unknown>) => {
    try {
      await stub.invoke('drive/record-text', { fileId: file.id, versionId: file.versionId, ...body });
    } catch (e) {
      // The file moved on while this was parsing — a newer upload is already
      // current, and its own extraction owns the text now. Extraction runs off
      // the request, so a 20 MB PDF uploaded first can still be working when a
      // 4 KB one lands after it; the slow one finishing last is ORDINARY, not a
      // failure, and the scope refusing its stale answer is the thing working.
      if (errorCodeOf(e) === 'conflict') return;
      throw e;
    }
  };

  try {
    // Imported HERE, not at the top. `@canopy/docworker/pdf` pulls in pdf.js —
    // about 570 KB gzipped of the worker's 1.26 MB — and this function runs on an
    // upload, never on a read. A static import would instantiate that module graph
    // in every isolate that serves a folder listing. The bytes are in the bundle
    // either way; what this saves is the startup cost of evaluating them.
    const { isPdf, pdfText } = await import('@canopy/docworker/pdf');

    if (!isPdf(file.name, file.mime)) {
      await record({ status: 'unsupported', detail: `no text extractor for ${file.mime || file.name}` });
      return;
    }

    const out = await pdfText(bytes, file.name, file.mime, { limit: MAX_INDEXED_CHARS });
    // A PDF of scanned pages parses perfectly and yields nothing. That is a fact
    // about the document, not a failure, and the two must not look alike.
    if (!out || out.text.trim() === '') {
      await record({ status: 'empty', detail: 'the document has no text layer' });
      return;
    }
    await record({ status: 'indexed', text: out.text });
  } catch (e) {
    // The extractor threw — a malformed file, an unsupported encoding, a bug.
    // Recorded rather than swallowed: a search that silently never covers one
    // document is indistinguishable from one that covers it and finds nothing.
    const detail = e instanceof Error ? e.message : String(e);
    console.error('drive.extract.failed', { fileId: file.id, detail });
    await record({ status: 'failed', detail }).catch((inner: unknown) => {
      // If even the recording fails the scope keeps "never extracted", which is
      // honest — a backfill sweep is what picks it up, and it is the same state
      // every file uploaded before this feature is already in.
      console.error('drive.extract.unrecorded', {
        fileId: file.id,
        detail: inner instanceof Error ? inner.message : String(inner),
      });
    });
  }
}

/**
 * Bytes in. Three hops, in the order the seam forces: ensure the file row exists (an
 * attachment binds to an entity, so the entity has to be there first), put the bytes
 * through the attachment surface — which never touches the scope's invoke pipe — then
 * record the version that names the attachment.
 *
 * The permission is checked twice and that is not redundant: `ensure-file` checks
 * `drive:write` on the folder, and the upload checks the declared target's write key
 * against the FILE. A caller who could create a row but not attach to it is refused
 * between the two, with the row already there — harmless, because a file with no
 * version is exactly what "created, nothing written yet" means.
 */
app.post('/api/folders/:folderId/content', async (c) => {
  const env = c.env;
  const principal = await principalFor(env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const node = nodeFor(c.req.raw, env);
  const name = c.req.query('name');
  if (!name) throw new HTTPException(400, { message: 'name is required' });

  const stub = await hostFor(env).getScope(principal, node.tenantId, node.scopeId);
  const file = await stub.invoke<{ id: string }>('drive/ensure-file', {
    folderId: c.req.param('folderId'),
    name,
  });

  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  const body = await readBounded(c.req.raw);
  const attachments = await hostFor(env).attachments(principal, node.tenantId, node.scopeId);
  const attachment = await attachments.upload({
    entity: { entityType: 'file', entityId: file.id },
    filename: name,
    contentType,
    visibility: 'internal',
    body,
  });

  // No mime or size passed: `record-version` reads both off the attachment row, so
  // the version describes the bytes that were actually stored.
  const written = await stub.invoke<{ id: string; current_version_id: string | null }>(
    'drive/record-version',
    { fileId: file.id, location: { source: 'blob', blobRef: attachment.id } },
  );

  // After the response, on the bytes already in this isolate — re-reading them
  // from the store would be a second full download of something we are holding.
  // `waitUntil` is what keeps the runtime alive for it without the caller waiting.
  if (written.current_version_id) {
    const work = extractAndRecord(
      stub,
      { id: file.id, versionId: written.current_version_id, name, mime: contentType },
      body,
    );
    await defer(c, work);
  }

  return c.json(written, 201);
});

/**
 * Bytes out. The version says where they are; the attachment surface decides whether
 * this caller may have them, checking the declared target's read key against the
 * owning file — the same key that let them see the row.
 */
app.get('/api/files/:fileId/content', async (c) => {
  const env = c.env;
  const principal = await principalFor(env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const node = nodeFor(c.req.raw, env);

  const stub = await hostFor(env).getScope(principal, node.tenantId, node.scopeId);
  const { file, version } = await stub.invoke<{
    file: { name: string };
    version: { source: string; blob_ref: string | null; mime: string } | null;
  }>('drive/get-file', { fileId: c.req.param('fileId') });
  if (!version) throw new HTTPException(404, { message: 'this file has no content yet' });

  // A connector-backed version's bytes are not ours: they live in the source system,
  // and resolving them means a connector this vertical does not have yet. Say that
  // plainly rather than serving an empty body that reads as an empty file.
  if (version.source !== 'blob' || !version.blob_ref) {
    throw new HTTPException(501, {
      message: 'this version lives in a connected source, and connector reads are not wired yet',
    });
  }

  const attachments = await hostFor(env).attachments(principal, node.tenantId, node.scopeId);
  const opened = await attachments.open(version.blob_ref);
  if (!opened) throw new HTTPException(404, { message: 'the bytes this version names are gone' });
  return new Response(opened.body, {
    headers: {
      'content-type': opened.contentType || version.mime,
      'content-disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
    },
  });
});

/**
 * The drive's own API: one hop to the space's scope, then the operation. A caller
 * who resolves to no principal never reaches a stub, so an unauthenticated request
 * is refused before any scope is touched.
 */
mountApi(app, async (c): Promise<ScopeStub> => {
  const env = c.env as Env;
  const principal = await principalFor(env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const node = nodeFor(c.req.raw, env);
  return hostFor(env).getScope(principal, node.tenantId, node.scopeId);
});

export default app;
