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
  /**
   * Both halves of "find it": the file's NAME, and what is inside it.
   *
   * The kernel's index reaches declared FIELDS, never bytes — so the content half
   * works by an extractor putting the text into a declared field first
   * (`file_text.text`) and the triggers doing the rest. That indirection IS the
   * feature: the index stays kernel-owned and trigger-maintained, and the drive
   * never writes to `_substrat_search_*`.
   *
   * `substring` on the body, `prefix` on the name. A filename is typed from the
   * front — people remember what a document is called — but a phrase from inside
   * a report is remembered from the middle, and a prefix tokenizer would miss it.
   * It costs a bigger index, which is the honest price of the feature.
   */
  ...manifestEntities(driveEntities, {
    searchables: [
      { entityType: 'file', fields: ['name'] },
      { entityType: 'file_text', fields: ['text'], tokenizer: 'substring' },
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
  lists: listsDeclaredBy(driveOperations, driveEntities),
  entitlementKey: 'drive',
});
