import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
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
  platformActorId,
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
  type ScopeSweepHost,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import { readRoutedNode, RouterAssertionError, type JobPassContext, type ScopeStub } from '@substrat-run/kernel';
import { mountLiveReads, mountPlatformSurface } from '@substrat-run/vertical-host';
import {
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  observePlace,
  placesReporter,
  reportScopeMembers,
  resetPlacesMemo,
  sha256Hex,
  type AuthProvider,
  type IdentityStub,
  type InstanceAuth,
} from '@substrat-run/vertical-auth';
/**
 * The subpath, not the barrel. `mountInviteRoutes` is the one module in `vertical-auth`
 * that imports `hono` at runtime, and the package keeps it off its index so a consumer
 * wanting only an `AuthProvider` does not resolve a peer it never uses.
 */
import { mountInviteRoutes } from '@substrat-run/vertical-auth/invite-routes';
import { mountApi } from '@canopy/scope-drive/routes';
import { placesFetch } from './places-fetch.js';
import { mountFileContent, type FileContentRecord } from './file-content.js';
import { mountTextContent, editableTextMime, type TextContentRecord } from './text-content.js';
import { removeMember } from './remove-member.js';
import { INVITABLE_ROLE_KEYS, MODULES, OWNER_ROLE_KEY, ROLES } from './provision.js';
import { driveManifest, DRIVE_PERM } from '@canopy/scope-drive';

const EXTRACTOR_REVISION = 'pdf-text-v2';
const BACKFILL_JOB = 'text-backfill';
const BACKFILL_BATCH = 20;
const BACKFILL_ACTOR = platformActorId.parse('01JZ00000000000000000SYS01');

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
const sweeperConfig = {
  versionId: (env) => env.SUBSTRAT_VERSION_ID ?? null,
  intervalMs: 120_000,
  host: hostFor,
  runJobs: true,
  jobStartIntervalMs: 12 * 60 * 60 * 1000,
  startJobs: async (host: ScopeSweepHost, tenant: TenantId, scope: ScopeId) => {
    await (host as CloudflareScopeHost).startJobRun(tenant, scope, {
      moduleId: driveManifest.id, job: BACKFILL_JOB, payload: { tenant, scope },
    });
  },
} satisfies Parameters<typeof defineScopeSweeperDO<Env>>[0];
export const SweeperDO = defineScopeSweeperDO<Env>(sweeperConfig);

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

/**
 * The (tenant, HOME space) the router asserted — no app-level selection applied.
 *
 * This is what identity keys on: one `IdentityDO` per TENANT, and the delivered auth
 * config belongs to the install the hostname routed to. It is also the registry the
 * space switcher reads, which is why it must not move when the app selects a space.
 */
function baseNode(req: Request, env: Env): Node {
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

/**
 * Which (tenant, SPACE) this request is for — the routed one, or another of the SAME
 * tenant that the app selected.
 *
 * Canopy's spaces are scopes, and a person is usually in several. One install therefore
 * has to serve more than the space its hostname named, or every space needs its own
 * hostname. The platform's answer (`multi-scope-manyfold.md`, epic #360) is this: the
 * app names the space it wants, by scope id (`x-scope`) or by the slug its own registry
 * knows (`x-site`) — or, where a header cannot ride, a `?site=` query parameter.
 *
 * The query parameter exists for exactly one shape: a plain link the browser follows
 * itself, like a download. `fetch` can set a header and an `<a href>` cannot, and
 * buffering a file through the app to send one would defeat the point of streaming it.
 * It is no weaker than the header for the reason below — both name an ADDRESS, and
 * neither grants anything — and the header wins when both are present, because the
 * app's own calls should not be steerable by something left in a URL.
 *
 * What makes it safe is what it does NOT do. The tenant always comes from the router's
 * assertion and is never taken from a header, the slug is resolved through the
 * PER-TENANT registry, and `getScope` re-checks the (tenant, scope) pair — so the worst
 * a forged header can name is another space of the same tenant, which the kernel's
 * checker then refuses unless the caller holds a role in it. A header cannot reach
 * another tenant, and it grants nothing anywhere.
 */
async function nodeFor(req: Request, env: Env): Promise<Node> {
  const base = baseNode(req, env);

  const byId = req.headers.get('x-scope');
  const parsed = byId ? scopeId.safeParse(byId) : null;
  if (parsed?.success) return { tenantId: base.tenantId, scopeId: parsed.data };

  const slug = req.headers.get('x-site') ?? new URL(req.url).searchParams.get('site');
  if (slug) {
    const resolved = await identityDo(env, base).resolveSiteScope(slug);
    const bySlug = resolved ? scopeId.safeParse(resolved) : null;
    if (bySlug?.success) return { tenantId: base.tenantId, scopeId: bySlug.data };
  }
  return base;
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    attachmentExtractors: defaultAttachmentExtractors(),
    // The byte side. The vertical never names a bucket: the platform mints one per
    // tenant and attaches it under a derived name, and this resolves that name. The
    // per-SCOPE isolation inside the store is the kernel's key prefix, not ours.
    attachmentBuckets: (tid) => env[blobStoreBindingName('BLOBS', tid)] as R2Bucket | undefined,
  });
  for (const m of MODULES) host.registerModule(m);
  host.registerJob(driveManifest.id, BACKFILL_JOB, async (pass: JobPassContext) => {
    const { tenant, scope: scopeId } = pass.payload as { tenant: TenantId; scope: ScopeId };
    const scope = await pass.scope();
    const page = await scope.invoke<{
      files: { id: string; versionId: string; name: string; mime: string; blobRef: string }[];
      next: string | null;
    }>('drive/list-extraction-candidates', {
      after: (pass.cursor as string | null) ?? undefined,
      limit: BACKFILL_BATCH,
      extractorRevision: EXTRACTOR_REVISION,
    });
    if (page.files.length === 0) return { cursor: page.next ?? pass.cursor, done: page.next === null };
    const attachments = await host.getSystemAttachments(driveManifest.id, tenant, scopeId);
    for (const file of page.files) {
      await pass.step(`${file.id}:${file.versionId}`, async () => {
        const opened = await attachments.open(file.blobRef);
        if (!opened) {
          await scope.invoke('drive/record-text', {
            fileId: file.id, versionId: file.versionId, extractorRevision: EXTRACTOR_REVISION,
            status: 'failed', detail: 'attachment bytes are missing',
          }).catch((error: unknown) => {
            if (errorCodeOf(error) !== 'conflict') throw error;
          });
          return true;
        }
        await extractAndRecord(scope, { id: file.id, versionId: file.versionId, name: file.name, mime: file.mime }, opened.body);
        return true;
      });
      pass.count('examined');
    }
    return { cursor: page.next ?? page.files.at(-1)?.id ?? pass.cursor, done: page.next === null };
  });
  return host;
}

/**
 * The identity DO's callable surface, widened by the four site-registry methods.
 *
 * `IdentityDO` implements and documents them; the exported `IdentityStub` TYPE just does
 * not list them, so a consumer outside the platform repo cannot call them without this.
 * Nothing here adds a capability — it names one the class already has. Filed as
 * substrat-run/substrat#1802; delete the intersection when the exported type carries them.
 */
type SiteRegistry = {
  recordSite(scopeId: string, slug: string, name: string): Promise<void>;
  forgetSite(scopeId: string): Promise<void>;
  listSites(): Promise<{ scopeId: string; slug: string; name: string }[]>;
  resolveSiteScope(slug: string): Promise<string | null>;
};

const identityDo = (env: Env, node: Node): IdentityStub & SiteRegistry =>
  env.AUTH.get(env.AUTH.idFromName(node.tenantId)) as unknown as IdentityStub & SiteRegistry;

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
    // No declared settings of our own; the auth choice rides the delivered map.
    envSpec: [],
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
  const provider = await providerFor(env, baseNode(req, env));
  const subject = await provider.resolve(req.headers);
  if (!subject) return null;
  const node = await nodeFor(req, env);
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
    const host = hostFor(env);
    const switchedOff = (await host.systemGrantsStatusLocal(b.scopeId)).some(
      (entry) => entry.moduleId === driveManifest.id && entry.schedules === 'off',
    );
    if (!switchedOff) {
      for (const permission of [DRIVE_PERM.read, DRIVE_PERM.write]) {
        await host.admin.grantToSystem(BACKFILL_ACTOR, {
          moduleId: driveManifest.id,
          permission,
          node,
          grantedBy: BACKFILL_ACTOR,
        });
      }
      await host.startJobRun(b.tenantId, b.scopeId, {
        moduleId: driveManifest.id,
        job: BACKFILL_JOB,
        payload: { tenant: b.tenantId, scope: b.scopeId },
      });
    }
    await identityDo(env, node).setPendingOwner(b.scopeId, b.owner);
    // This space, in the vertical's OWN per-tenant registry (M2 of
    // `multi-scope-manyfold.md`). It is what lets the app list and switch spaces
    // without reaching the control plane — which a sandbox-clean vertical cannot do.
    // Idempotent, and re-run by every reconcile, so a lost record repairs itself.
    if (b.slug && b.name) await identityDo(env, node).recordSite(b.scopeId, b.slug, b.name);
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
    // NOT dropped from the space registry here, and it cannot be: this hook is handed a
    // scope id and no tenant, and the registry lives in the per-TENANT identity DO. A
    // deleted space therefore lingers in the switcher until something with a tenant in
    // hand removes it — an archive route, which canopy does not have yet. Manyfold's
    // equivalent calls `forgetSite` from exactly such a route.
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
 * The relying-party flow: login, callback, logout. This vertical runs no credential
 * store and hosts no sign-up — the issuer owns the password — but the cookie session
 * every other route reads is established HERE, and without these three routes there is
 * no way for a browser to acquire one.
 */
app.on(['GET', 'POST'], '/api/auth/*', async (c) =>
  (await providerFor(c.env, baseNode(c.req.raw, c.env))).handle(c.req.raw),
);

/**
 * Who is in this space, and how someone else gets in (#79).
 *
 * Four routes, mounted rather than written: list the open invites, create one, revoke
 * one, accept one. Canopy had its own invite flow against the shared database; this is
 * the same feature as a platform contract, and the contract does the part that is easy
 * to get wrong — the token is stored only as a hash, the role is granted BEFORE the row
 * is written, and a row that then fails to write takes the grant back rather than
 * leaving a principal nobody can bind to holding a role.
 *
 * What the vertical owns is the gate, because only the vertical knows what "may manage
 * the people here" means. Ours is `drive/people-access`, which is an OPERATION for a
 * reason: an app-side `ScopeStub` can only `invoke`, so a route has no way to ask the
 * kernel a permission question except by invoking something that does. The alternative
 * would be re-deciding authorization out here from a role name — the hand-rolled check
 * beside the enforced one, which is the failure this platform exists to remove.
 *
 * The server offers bounded viewer/editor/owner roles and retains legacy member invites.
 */
/**
 * The gate on every people route, and it answers WHO is asking.
 *
 * The decision itself is `drive/people-access` — an operation, because an app-side stub can
 * only invoke and the alternative is re-deciding authorization out here from a role name. The
 * principal comes back because the removal route needs it: to act as somebody, and to refuse
 * removing them.
 */
async function requirePeopleAdmin(c: Context<{ Bindings: Env }>): Promise<PrincipalId> {
  const principal = await principalFor(c.env, c.req.raw);
  // 401 and 403 are different answers and these routes let us say which: nobody is signed in,
  // versus signed in and not the person who administers this space.
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const node = await nodeFor(c.req.raw, c.env);
  const stub = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
  const { canManage } = await stub.invoke<{ canManage: boolean }>('drive/people-access');
  if (!canManage) {
    throw new HTTPException(403, { message: 'only an owner can manage the people in this space' });
  }
  return principal;
}

mountInviteRoutes<Env, Node>(app, {
  nodeFor,
  requireAdmin: async (c) => ({ principal: await requirePeopleAdmin(c) }),
  canAssign: (env, node, principal, roleKey) =>
    hostFor(env).canAssign(node.tenantId, node.scopeId, principal, roleKey),
  assignScopeRoleBounded: (env, node, caller, assignee, roleKey) =>
    hostFor(env).assignScopeRoleBounded(node.tenantId, node.scopeId, caller, assignee, roleKey),
  roles: INVITABLE_ROLE_KEYS,
  directory: (env, node) => identityDo(env, node),
  // Scope-local, no control plane: the bounded grant lands where the checker reads.
  revokeScopeRole: (env, scopeId, principal, roleKey) =>
    hostFor(env).revokeScopeRole(scopeId, principal, roleKey),
  // The INSTALL's provider, never the selected space's: identity is the install's and
  // membership is the space's, the same split `/api/me` documents.
  authProvider: (env, req) => providerFor(env, baseNode(req, env)),
});

/**
 * Remove somebody from this space (#79) — all three parts of it, in the order that fails safe.
 *
 * Membership is not one fact. A person reaches this drive through a subject bound to a
 * principal, a role held at the scope, and whatever folder grants they were given — and the
 * drive owns only the last of those. Doing one and not the others is the failure mode worth
 * designing against: until now nothing removed anybody at all, and the People dialog had to
 * say so.
 *
 * The ORDER is the safety property, because any step can fail — and this order is the SECOND
 * one, because the first was wrong:
 *
 *  1. **The binding first.** Unbinding the subject is the only step that cuts access to
 *     EVERYTHING at once, including a grant the drive never recorded: principal resolution goes
 *     through the directory on every request, so an unbound subject resolves to nobody even
 *     holding a live session cookie. A failure after this leaves somebody who cannot act at
 *     all; a failure OF this leaves them exactly as they were, with the caller told so.
 *  2. **Then the folder grants** (`drive/forget-person`), which is what the drive recorded.
 *  3. **Then the roles**, which is space-wide read gone, and every role this vertical defines
 *     rather than the one invites use — a co-owner must be removable too.
 *
 * Grants before the binding was the wrong way round, and review caught the hole: this table is
 * a projection, and a grant made through the platform's admin seam has no row here (the
 * migration says so). `forget-person` skips what it cannot see, so with the old order a failure
 * between steps left a still-bound person holding real access that the route had just reported
 * as revoked. Unbinding first means the worst case is an orphaned grant held by a principal
 * nobody can be, which the retry clears.
 *
 * Stop anywhere and the person has strictly less than before, and a retry finishes the job:
 * every step is idempotent.
 *
 * What this cannot claim: that every grant is gone. Nothing enumerates kernel grants, which is
 * the whole reason the projection exists — so removal revokes what the drive recorded, and the
 * unbind is what makes the rest unreachable rather than absent.
 */
app.delete('/api/people/:principal', async (c) => {
  const asking = await requirePeopleAdmin(c);
  const target = c.req.param('principal');

  // Not yourself. Nothing else guarantees an administrator remains — every other owner could
  // be removed by one who then removes themselves, leaving a space nobody can administer, and
  // the platform's claim link is a poor answer to "I locked myself out of my own drive".
  if (target === asking) {
    throw new HTTPException(400, {
      message: 'you cannot remove yourself from a space you administer',
    });
  }

  const node = await nodeFor(c.req.raw, c.env);
  const host = hostFor(c.env);
  const removed = principalId.parse(target);
  const directory = identityDo(c.env, node);
  const stub = await host.getScope(asking, node.tenantId, node.scopeId);

  // The order lives in `remove-member.ts`, where it is tested — including what each failure
  // leaves behind, which is the half that cannot be checked by reading. This route's job is to
  // supply the three steps against the real bindings.
  const outcome = await removeMember({
    unbind: async () => {
      const instance = await instanceFor(c.env, baseNode(c.req.raw, c.env));
      // Substrat #1951 adds this principal-wide operation. The installed release's
      // IdentityStub type has not caught up yet; this draft must wait for that release.
      const principalDirectory = directory as typeof directory & {
        unbindPrincipal(scopeId: string, principal: string): Promise<string[]>;
      };
      const subs = await principalDirectory.unbindPrincipal(node.scopeId, target);
      const reporter = reporterFor(instance.identity);
      // A prior present report may be memoized in this isolate. Flush that memo so a
      // subsequent login observes the now-absent place even if an issuer report was lost.
      // Switch to upstream unbindPrincipalMember when it is published; it clears only
      // these subjects' memo entries.
      resetPlacesMemo();
      for (const sub of subs) await reporter?.absent(node.scopeId, sub);
      return subs.length;
    },
    forgetGrants: () =>
      stub.invoke<{ revoked: number; forgotten: boolean }>('drive/forget-person', {
        principal: target,
      }),
    revokeRoles: async () => {
      // Every role this vertical defines, not just the one invites use: a co-owner must be
      // removable, and a role left behind is space-wide read left behind.
      for (const role of ROLES) {
        await host.revokeScopeRole(node.scopeId, removed, role.key);
      }
      return ROLES.length;
    },
  });

  return c.json({ principal: target, ...outcome });
});

/**
 * The spaces this tenant has in this install — the switcher's list.
 *
 * Read from the BASE node's registry, never the selected one: the registry is per
 * tenant, and reading it through a selected space would make the list depend on which
 * space you happen to be looking at.
 *
 * Slug and name only. The scope id is the address, and a caller that does not need it
 * should not be handed it; `x-site` takes the slug.
 */
app.get('/api/sites', async (c) => {
  const base = baseNode(c.req.raw, c.env);

  // The SUBJECT, not a principal: who is asking is a fact about the install, and a
  // principal is a fact about ONE space (K-22 — the same login is a different principal
  // in each). Going through `principalFor` here asked the wrong question: it resolves
  // against the SELECTED space, so a member of three spaces who happens to be looking at
  // a fourth got 401 from the very endpoint that would have let them leave it.
  const subject = await (await providerFor(c.env, base)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'unauthorized' });

  const directory = identityDo(c.env, base);
  const host = hostFor(c.env);

  /**
   * A space is listed when this login is bound in it AND it still resolves.
   *
   * Both halves are per space, so both are asked per space. The binding is what makes
   * the entry mean "you can open this"; the stub is what makes it mean "it is still
   * there" — the registry is written at provision and nothing can remove an entry when
   * a space is deleted (`onDeleteScope` carries no tenant, and the registry is per
   * tenant), so without this a deleted space would sit in the switcher forever.
   *
   * Selecting a dead space was never dangerous: `getScope` validates the (tenant, scope)
   * pair against the directory and refuses an unknown or inactive scope (K-3). This is
   * about the list being honest, not about the data path being safe.
   *
   * A signed-in caller bound in NO space gets an empty list rather than 401. They are
   * authenticated; they simply have nowhere to go, and that is what the switcher should
   * say.
   */
  const registered = await directory.listSites();
  const mine = await Promise.all(
    registered.map(async (site) => {
      const principal = await directory.resolvePrincipal(site.scopeId, subject.sub);
      if (!principal) return null;
      try {
        await host.getScope(principalId.parse(principal), base.tenantId, scopeId.parse(site.scopeId));
        return site;
      } catch {
        return null;
      }
    }),
  );

  /**
   * WHICH of them this request is looking at — the one fact the client cannot work out.
   *
   * A selection rides as `x-site` and so is already known in the browser, but the
   * DEFAULT is the scope the router asserted from the hostname, and its slug is only
   * knowable here. Without this a space list can say what you have and not where you
   * are, which is the one thing a list of places is for.
   *
   * Still slug and name: `current` is a boolean about this request, not the scope id.
   */
  const here = (await nodeFor(c.req.raw, c.env)).scopeId;

  return c.json(
    mine
      .filter((site) => site !== null)
      .map((site) => ({ slug: site.slug, name: site.name, current: site.scopeId === here })),
  );
});

/** Who am I — the first call every client makes. */
app.get('/api/me', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  // The auth config belongs to the INSTALL the hostname routed to, so it is read
  // through `baseNode` — never through the selected space. A selected space carries no
  // `substrat:auth` of its own, so reading it there would answer 503 for a caller whose
  // base session is perfectly good. Identity is the install's; membership is the
  // space's, and `node` below is what resolves that.
  const instance = await instanceFor(c.env, baseNode(c.req.raw, c.env));
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

  /**
   * And tell the DRIVE what to call them (#79), for the same reason and in the same place.
   *
   * A grant names a principal, and a principal is a ULID — so a share dialog that has to
   * let someone pick a PERSON needs an email beside it. Nothing in the platform keeps one:
   * the identity directory maps a subject to a principal and stores no display identity,
   * and the invite row that carried an email stops existing when it is accepted.
   *
   * Here is where it can be known truthfully. `subject.email` and `subject.name` come off
   * a verified session, which is exactly why `drive/record-person` has no HTTP route — over
   * one, a member could write another member's address onto their own row. This call is the
   * only way in, and it can only ever record the caller.
   *
   * After the response, like the report above: this is bookkeeping, and nobody's screen
   * should wait for it. A failure is dropped for the same reason — `/api/me` answering
   * "who you are" must not fail because a display name could not be filed.
   */
  if (principal) {
    const who = principalId.parse(principal);
    // EVERY bound principal, and every part of it deferred.
    //
    // Three things this got wrong when written. Gating on a claim being present meant a
    // principal whose issuer releases neither name nor email was never recorded at all —
    // so the roster's "a principal and nothing else" row, which the UI renders and a test
    // covers, could not actually occur. It also meant a claim the issuer STOPPED releasing
    // was never cleared, leaving a name nothing upstream still asserts. And `getScope` was
    // awaited out here, ahead of the defer and outside the catch, so its latency was on the
    // critical path of `/api/me` and its failure was the route's failure — for bookkeeping.
    //
    // Now the whole chain is inside the swallowed promise: nulls are written as nulls, and
    // "who you are" cannot fail because a display name could not be filed.
    await defer(
      c,
      (async () => {
        try {
          const scope = await hostFor(c.env).getScope(who, node.tenantId, node.scopeId);
          await scope.invoke('drive/record-person', {
            email: subject?.email ?? null,
            name: subject?.name ?? null,
          });
        } catch {
          // Bookkeeping. The answer above has already gone out.
        }
      })(),
    );
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
  const node = await nodeFor(c.req.raw, c.env);
  // Same rule as `/api/me`: who you ARE comes from the install, what you may claim is
  // the selected space's seat.
  const subject = await (await providerFor(c.env, baseNode(c.req.raw, c.env))).resolve(c.req.raw.headers);
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
 * Runs after the upload's response or in a durable backfill pass. Extraction is slow enough to
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
      await stub.invoke('drive/record-text', { fileId: file.id, versionId: file.versionId, extractorRevision: EXTRACTOR_REVISION, ...body });
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
    if (editableTextMime(file.mime)) {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).slice(0, MAX_INDEXED_CHARS);
      await record(text.trim() ? { status: 'indexed', text } : { status: 'empty', detail: 'the document has no text' });
      return;
    }
    // Imported HERE, not at the top. `@canopy/docworker/pdf` pulls in pdf.js —
    // about 570 KB gzipped of the worker's 1.26 MB — and this function runs on
    // uploads and backfill, never on a read. A static import would instantiate that module graph
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
  const node = await nodeFor(c.req.raw, env);
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
    await hostFor(env).startJobRun(node.tenantId, node.scopeId, {
      moduleId: driveManifest.id,
      job: BACKFILL_JOB,
      payload: { tenant: node.tenantId, scope: node.scopeId },
    }).catch((error: unknown) => {
      console.error('drive.backfill.queue-failed', {
        fileId: file.id, error: error instanceof Error ? error.message : String(error),
      });
    });
    const work = extractAndRecord(
      stub,
      { id: file.id, versionId: written.current_version_id, name, mime: contentType },
      body,
    );
    await defer(c, work);
  }

  return c.json(written, 201);
});

/** An administrator can request a fresh, coalesced pass without waiting for the timer. */
app.post('/api/maintenance/text-backfill', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const node = await nodeFor(c.req.raw, c.env);
  const host = hostFor(c.env);
  const stub = await host.getScope(principal, node.tenantId, node.scopeId);
  const access = await stub.invoke<{ canManage: boolean }>('drive/people-access');
  if (!access.canManage) throw new HTTPException(403, { message: 'manage access required' });
  const run = await host.startJobRun(node.tenantId, node.scopeId, {
    moduleId: driveManifest.id,
    job: BACKFILL_JOB,
    payload: { tenant: node.tenantId, scope: node.scopeId },
  });
  return c.json({ runId: run.id, status: run.status }, 202);
});

/**
 * Bytes out. The version says where they are; the attachment surface decides whether
 * this caller may have them, checking the declared target's read key against the
 * owning file — the same key that let them see the row.
 */
mountTextContent(app, async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) return null;
  const node = await nodeFor(c.req.raw, c.env);
  const host = hostFor(c.env);
  const stub = await host.getScope(principal, node.tenantId, node.scopeId);
  return {
    getFile: (fileId) => stub.invoke<TextContentRecord>('drive/get-file', { fileId }),
    upload: async (id, name, mime, body) => {
      const attachment = await (await host.attachments(principal, node.tenantId, node.scopeId)).upload({
        entity: { entityType: 'file', entityId: id }, filename: name, contentType: mime, visibility: 'internal', body,
      });
      return attachment.id;
    },
    record: (fileId, blobRef, expectedCurrentVersion) => stub.invoke<{ id: string; current_version_id: string | null }>(
      'drive/record-version', { fileId, expectedCurrentVersion, location: { source: 'blob', blobRef } },
    ),
    afterWrite: (file, bytes) => extractAndRecord(stub, file, bytes),
  };
});

mountFileContent(app, async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) return null;
  const node = await nodeFor(c.req.raw, c.env);
  const host = hostFor(c.env);
  const stub = await host.getScope(principal, node.tenantId, node.scopeId);
  return {
    getFile: (fileId, versionId) => stub.invoke<FileContentRecord>(
      versionId ? 'drive/get-version' : 'drive/get-file',
      versionId ? { fileId, versionId } : { fileId },
    ),
    openAttachment: async (id) => (await host.attachments(principal, node.tenantId, node.scopeId)).open(id),
  };
});

/**
 * The drive's own API: one hop to the space's scope, then the operation. A caller
 * who resolves to no principal never reaches a stub, so an unauthenticated request
 * is refused before any scope is touched.
 */
mountLiveReads(app, {
  live: (c) => hostFor(c.env).liveReads,
  subscriber: async (c) => {
    const principal = await principalFor(c.env, c.req.raw);
    if (!principal) return null;
    const node = await nodeFor(c.req.raw, c.env);
    return { ...node, principal };
  },
});

mountApi(app, async (c): Promise<ScopeStub> => {
  const env = c.env as Env;
  const principal = await principalFor(env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  const node = await nodeFor(c.req.raw, env);
  return hostFor(env).getScope(principal, node.tenantId, node.scopeId);
});

export default app;
