/**
 * The drive's provisioning surface: modules, roles and grant shapes, with no
 * `node:*` anywhere — so the Cloudflare worker can bundle it and `substrat push`
 * can read the permission registry out of it.
 *
 * Everything here is the canopy sharing model restated in the kernel's terms, and
 * the restatement is the interesting part:
 *
 * - **A space member reads the space.** That is what membership already means in
 *   canopy — a family space is shared by being a space, not by granting every
 *   folder in it — so `drive:read` is the role, held scope-wide.
 * - **Writing is granted on a folder**, never scope-wide, and reaches everything
 *   beneath it through the declared parent edge. `folder_grants` + the `pathRole`
 *   ancestor walk become one grant and one declared edge.
 * - **The owner of a space holds both**, on the root folder, which is the whole of
 *   canopy's owner role.
 */
import { definePermissions, type PermissionKey, type RoleDefinition } from '@substrat-run/contracts';
import { DRIVE_PERMISSIONS } from '../spec/model.js';
import { DRIVE_PERM } from './manifest.js';
import { driveModule } from './module.js';

/** The modules this vertical composes, in registration order. */
export const MODULES = [driveModule];

/** Entitlements are default-deny: one SKU key per module this vertical runs. */
export const ENTITLEMENT_KEYS = ['drive'];

/**
 * The role table, identical in every tenant.
 *
 * Two roles, because a space has two kinds of people in it and they differ in what
 * they may do to the WHOLE space:
 *
 * - **`owner`** holds all three keys scope-wide. That is not a weakening: the owner of
 *   a space may write anywhere in their own space, which is the same thing said in the
 *   kernel's vocabulary. It is also the only way the installer can use what they just
 *   installed — `/internal/provision` assigns a scope-level ROLE and nothing else, so a
 *   permission that exists only as an entity grant is a permission a fresh install's
 *   owner does not have.
 * - **`member`** reads. Writing for a member is granted per folder, which keeps one
 *   member from editing another's folders — the distinction canopy's viewer/editor
 *   ladder already draws, and the reason `drive:write` is not in this role.
 */
export const ROLES: RoleDefinition[] = [
  {
    key: 'owner',
    permissions: [DRIVE_PERM.read, DRIVE_PERM.write, DRIVE_PERM.manage],
    source: 'vertical',
  },
  { key: 'member', permissions: [DRIVE_PERM.read], source: 'vertical' },
];

/** The role the installing owner holds — what `/internal/provision` assigns. */
export const OWNER_ROLE_KEY = 'owner';

/**
 * The entity-narrowed grant SHAPES — which keys are reachable outside the role table.
 * This is sharing: `drive:write` on ONE folder for ONE person, reaching everything
 * beneath it through the declared parent edge. The grants themselves are per-principal
 * and minted at runtime, so they can never be a build artifact; the shape is what a
 * reviewer reads instead.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'folder', permissions: [DRIVE_PERM.write, DRIVE_PERM.manage] },
];

/**
 * The single typed source for this vertical's permission surface, read by the
 * permission checkpoint and by `substrat push` (package.json `substrat.permissions`).
 * `keys` is the same array `spec/model.ts` hands `defineOperations`, so the two
 * cannot disagree without throwing at load.
 */
export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
  keys: DRIVE_PERMISSIONS,
});
