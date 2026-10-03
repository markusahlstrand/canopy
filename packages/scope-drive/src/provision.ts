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
 * - **Writing may be granted on a folder**, or scope-wide to an editor, and reaches everything
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

/** Scope-wide roles matching the portal's viewer/editor/owner invite choices.
 * Existing member bindings remain read-only; folder grants still narrow legacy access.
 */
export const ROLES: RoleDefinition[] = [
  {
    key: 'owner',
    permissions: [DRIVE_PERM.read, DRIVE_PERM.write, DRIVE_PERM.manage],
    source: 'vertical',
  },
  { key: 'viewer', permissions: [DRIVE_PERM.read], source: 'vertical' },
  { key: 'editor', permissions: [DRIVE_PERM.read, DRIVE_PERM.write], source: 'vertical' },
  { key: 'member', permissions: [DRIVE_PERM.read], source: 'vertical' },
];

/** The role the installing owner holds — what `/internal/provision` assigns. */
export const OWNER_ROLE_KEY = 'owner';

/** Legacy member invitations remain supported for folder-sharing clients. */
export const MEMBER_ROLE_KEY = 'member';
/** Every invitation and claim is checked by the platform's bounded role assignment. */
export const INVITABLE_ROLE_KEYS = ['viewer', 'editor', 'owner', MEMBER_ROLE_KEY];

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
