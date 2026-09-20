/**
 * The drive module's declarative surface, assembled from the model the same way
 * every Substrat module assembles it — the permission keys and emitted events are
 * read off the operations, the parent edges off the entities. What is written here
 * is what is a fact about this deployment rather than about the drive.
 */
import {
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
} from '@substrat-run/contracts';
import { driveEntities, driveOperations } from '../spec/model.js';

export const DRIVE_PERM = {
  read: permissionKey.parse('drive:read'),
  write: permissionKey.parse('drive:write'),
  manage: permissionKey.parse('drive:manage'),
} as const;

export const driveManifest = moduleManifest.parse({
  id: '@canopy/scope-drive',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(driveOperations, {
    permissions: {
      'drive:read': 'See a folder and the files in it',
      'drive:write': 'Add files and folders, and supersede a file with a new version',
      'drive:manage': 'Share a folder and delete what is in it',
    },
  }),
  // A file's NAME only, for this slice. Content search is the other half and it
  // needs an extractor — the index over declared fields cannot reach bytes.
  ...manifestEntities(driveEntities, {
    searchables: [{ entityType: 'file', fields: ['name'] }],
  }),
  lists: listsDeclaredBy(driveOperations, driveEntities),
  entitlementKey: 'drive',
});
