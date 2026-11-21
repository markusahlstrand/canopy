import { defineConnectors } from '@substrat-run/vertical-host/connectors';
import { a3docConnectorDefinition, a3docFolderChecks, A3DOC_VERTICAL_PROVIDER } from '@canopy/connector-a3docs';
import { qontoConnectorDefinition, QONTO_VERTICAL_PROVIDER } from '@canopy/connector-qonto';
import { s3ConnectorDefinition, s3FolderChecks, S3_VERTICAL_PROVIDER } from '@canopy/connector-s3';
import { withFolderChecks } from './folder-checks.js';

const journalOperation = 'drive/source-write-journal';

/**
 * Bundled by the worker and read by `substrat push` from the same entry.
 *
 * a3doc and S3 can check one folder when someone opens it (`withFolderChecks`). Qonto cannot:
 * its folders are the connector's own year/month buckets, not anything Qonto can list, so a
 * folder check there runs its ordinary incremental pass, which reads what changed since the last.
 */
export const connectors = defineConnectors({
  [A3DOC_VERTICAL_PROVIDER]: withFolderChecks(a3docConnectorDefinition({ journalOperation }), a3docFolderChecks()),
  [QONTO_VERTICAL_PROVIDER]: qontoConnectorDefinition(),
  [S3_VERTICAL_PROVIDER]: withFolderChecks(s3ConnectorDefinition({ journalOperation }), s3FolderChecks({ journalOperation })),
});
