---
"@canopy/api": patch
"@canopy/docworker-service": patch
"@canopy/drive-vertical": patch
"@canopy/model-editor-demo": patch
"canopy-model-editor": patch
"@canopy/connector-a3docs": patch
"@canopy/connector-local": patch
"@canopy/connector-synology": patch
"@canopy/docworker": patch
"@canopy/mirror": patch
"@canopy/model-editor": patch
"@canopy/plugin-sdk": patch
"@canopy/plugin-sources": patch
"@canopy/plugin-validator": patch
"@canopy/scope-drive": patch
"@canopy/store": patch
"@canopy/ui": patch
---

Update every dependency to its latest release: Substrat 0.170 (vertical-auth 0.28.10, attachment-extractors 0.2.31, CLI 0.54.1, dev-issuer 0.2.52), React 19.3.1, Vite 8.3.5, wrangler 4.156, Hono 4.13.14, Zod 4.6.7, MCP SDK 1.32.2, TypeSpec 1.17, lucide-react 1.65, radix-ui 1.8, unpdf 2 and es-module-lexer 3. The npm plugin import now detects `import.meta` through es-module-lexer 3's `type: 'import-meta'` instead of the removed `d === -2` marker. No contract, model or permission changes.
