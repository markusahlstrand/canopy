import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Plugin boundary: trusted plugin views must reach the host through the
    // @canopy/plugin-sdk capability bridge and use @canopy/ui for UI/icons/toast —
    // never app internals. This keeps plugins decoupled (and portable to other
    // hosts). Extend the file globs as more plugin views are migrated onto the SDK.
    files: ['src/components/model-editor/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/api',
                '@/lib/icons',
                '@/lib/utils',
                '@/components/ui/*',
                '@/plugins',
                '@/plugins/*',
                'sonner',
              ],
              message:
                'Plugins must use @canopy/plugin-sdk for host capabilities and @canopy/ui for UI/icons/toast — not app internals.',
            },
          ],
        },
      ],
    },
  },
  {
    // Trusted first-party plugin views (hybrid boundary): UI/icons/toast and shared
    // host components come from @canopy/ui; generic host capabilities come from the
    // @canopy/plugin-sdk bridge. Feature-specific endpoints (GitHub data-source,
    // document-ai processing) stay app-coupled, so only the *generic* @/lib/api names
    // — the ones with a HostBridge home — are banned here, not @/lib/api wholesale.
    files: [
      'src/plugins/detail-views.tsx',
      'src/plugins/github-view.tsx',
      'src/plugins/synology-view.tsx',
      'src/plugins/document-ai-view.tsx',
      'src/plugins/documentation-view.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/icons',
                '@/lib/utils',
                '@/components/ui/*',
                '@/plugins/host',
                '@/components/plugin-settings-dialog',
                '@/components/person-avatar',
                'sonner',
              ],
              message: 'Use @canopy/ui for UI/icons and @canopy/plugin-sdk for the settings dialog — not app internals.',
            },
          ],
          paths: [
            {
              name: '@/lib/api',
              importNames: [
                'fetchFileText',
                'saveFileVersion',
                'createFile',
                'getFile',
                'listFiles',
                'aiGenerate',
                'listAiModels',
                'getPluginSettings',
                'savePluginSettings',
                'getPluginPlaces',
                'applySpacePlugin',
                'removeSpacePlugin',
                'listSpaces',
                'syncConnector',
                'testConnector',
                'listMount',
                'readText',
                'mountFileUrl',
              ],
              message: 'These are host capabilities — call them via usePluginHost() from @canopy/plugin-sdk.',
            },
          ],
        },
      ],
    },
  },
])
