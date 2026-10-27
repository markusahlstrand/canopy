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
  landSource: permissionKey.parse('drive:land-source'),
} as const;

export const driveManifest = moduleManifest.parse({
  id: '@canopy/scope-drive',
  version: '0.2.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(driveOperations, {
    permissions: {
      'drive:land-source': 'Land connector files and content in this space',
      'drive:read': 'See a folder and the files in it',
      'drive:write': 'Add files and folders, and supersede a file with a new version',
      'drive:manage': 'Share a folder and delete what is in it',
    },
  }),
  /**
   * The drive's own search indexes: a file's NAME and its descriptive metadata.
   *
   * What is INSIDE a file is the kernel's: every upload's text is extracted into the
   * kernel's attachment text index, and `drive/search` ranks it beside these (#169).
   *
   * `prefix` on the name, `substring` on the metadata. A filename is typed from the front,
   * because people remember what a document is called; a description or label is
   * remembered from the middle, and a prefix tokenizer would miss it.
   */
  ...manifestEntities(driveEntities, {
    searchables: [
      { entityType: 'file', fields: ['name'] },
      { entityType: 'file_details', fields: ['description', 'labels_json'], tokenizer: 'substring' },
    ],
  }),
  /**
   * Bytes bind to a FILE, and the kernel gates them with the same keys the operations
   * use — `list`/`open` check `drive:read`, `upload`/`remove` check `drive:write`,
   * both per-entity, so a grant narrowed to one folder reaches the bytes under it and
   * nothing else. The drive holds no second rule about who may download what.
   */
  attachmentTargets: [
    {
      entityType: 'file',
      readPermission: DRIVE_PERM.read,
      writePermission: DRIVE_PERM.write,
    },
  ],
  // Live frames carry only the changed id. The scope checks drive:read on that
  // exact entity for each subscriber before it sends an invalidation.
  liveTargets: [
    { entityType: 'folder', readPermission: DRIVE_PERM.read },
    { entityType: 'file', readPermission: DRIVE_PERM.read },
  ],
  lists: listsDeclaredBy(driveOperations, driveEntities),
  connections: [{ provider: 'canopy.a3doc', operation: 'drive/land-source-change', permission: 'drive:land-source' }],
  entitlementKey: 'drive',
});
