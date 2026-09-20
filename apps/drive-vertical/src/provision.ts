/**
 * What `substrat push` reads (package.json `substrat.permissions`) and what the
 * worker registers. A re-export, not a second declaration: the surface belongs to
 * `@canopy/scope-drive`, and a copy here would be the drift the checkpoint exists
 * to catch.
 */
export {
  ENTITLEMENT_KEYS,
  ENTITY_GRANTS,
  MODULES,
  OWNER_ROLE_KEY,
  ROLES,
  permissions,
} from '@canopy/scope-drive/provision';
