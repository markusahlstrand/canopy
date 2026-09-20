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
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import {
  CloudflareScopeHost,
  defineScopeDO,
  defineScopeSweeperDO,
  SCOPE_SWEEPER_NAME,
  type ScopeSweeperDo,
} from '@substrat-run/adapter-cloudflare';
import { readRoutedNode, RouterAssertionError, type ScopeStub } from '@substrat-run/kernel';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { IdentityDO, type IdentityStub } from '@substrat-run/vertical-auth';
import { oidcRpAuthProvider } from '@substrat-run/vertical-auth/oidc-rp-provider';
import { mountApi } from '@canopy/scope-drive/routes';
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
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const identityDo = (env: Env, node: Node): IdentityStub =>
  env.AUTH.get(env.AUTH.idFromName(node.tenantId)) as unknown as IdentityStub;

/**
 * The scope's auth provider, built from what this INSTALL was configured with.
 *
 * `authWiring` is one DO hop for both halves: the config the platform delivered to
 * this scope (the Identity tab's `substrat:auth` choice) and the tenant's own
 * session-signing secret, minted in the DO on first use and never a worker binding —
 * one serving script runs every install, so a shared binding would be the same
 * secret for all of them. Env vars are the local-dev fallback only.
 *
 * Absent issuer ⇒ no provider ⇒ nobody authenticates. That is the honest state for
 * a fresh deploy, and it fails closed rather than inventing a caller.
 */
async function providerFor(env: Env, node: Node) {
  const wiring = await identityDo(env, node).authWiring(node.scopeId);
  const delivered = wiring.config;
  const issuer = delivered['substrat:auth:issuer'] ?? env.OIDC_ISSUER;
  if (!issuer) return null;
  return oidcRpAuthProvider({
    issuer,
    clientId: delivered['substrat:auth:clientId'] ?? env.OIDC_CLIENT_ID ?? '',
    clientSecret: delivered['substrat:auth:clientSecret'] ?? env.OIDC_CLIENT_SECRET ?? '',
    sessionSecret: wiring.sessionSecret,
  });
}

/** Subject → principal in this scope, or null for nobody. */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  const provider = await providerFor(env, nodeFor(req, env));
  if (!provider) return null;
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
  // Who the install belongs to, read from the same directory the platform's
  // provision hook writes — never from a role table, which says what an owner may
  // do and not which person they are.
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  onConfigure: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries),
  ownerSeat: (env, ref) => identityDo(env, ref).ownerSeat(ref.scopeId),
});

/** Who am I — the first call every client makes. */
app.get('/api/me', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  return principal ? c.json({ principal }) : c.json({ error: 'unauthorized' }, 401);
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
