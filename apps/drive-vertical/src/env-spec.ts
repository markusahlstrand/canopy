import type { EnvVarSpec } from '@substrat-run/contracts';

/**
 * What an install may configure, as the dashboard's Env tab renders it.
 *
 * Declared per INSTALL rather than taken from a worker binding, and the difference
 * is load-bearing: one serving script runs every tenant's install, so a binding
 * would be the same value for all of them. The delivered map is per scope.
 */
export const DRIVE_VERTICAL_ENV: EnvVarSpec[] = [
  {
    key: 'PORTAL_ORIGIN',
    label: 'Portal origin',
    description:
      'The exact origin of a Canopy portal allowed to read this space from the browser — scheme, host and port, no trailing slash (https://app.example.com). Left empty, no cross-origin caller is allowed, which is the right default: this is the only setting that lets another site read this drive with the visitor’s session.',
    placeholder: 'https://app.example.com',
    required: false,
    secret: false,
    group: 'Portal',
  },
];
