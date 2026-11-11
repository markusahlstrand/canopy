import { defineConnectors } from '@substrat-run/vertical-host/connectors';
import { a3docConnectorDefinition, A3DOC_VERTICAL_PROVIDER } from '@canopy/connector-a3docs';
import { qontoConnectorDefinition, QONTO_VERTICAL_PROVIDER } from '@canopy/connector-qonto';
import { s3ConnectorDefinition, S3_VERTICAL_PROVIDER } from '@canopy/connector-s3';

/** Bundled by the worker and read by `substrat push` from the same entry. */
export const connectors = defineConnectors({
  [A3DOC_VERTICAL_PROVIDER]: a3docConnectorDefinition({ journalOperation: 'drive/source-write-journal' }),
  [QONTO_VERTICAL_PROVIDER]: qontoConnectorDefinition(),
  [S3_VERTICAL_PROVIDER]: s3ConnectorDefinition({ journalOperation: 'drive/source-write-journal' }),
});
