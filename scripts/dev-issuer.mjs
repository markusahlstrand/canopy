import { serve } from '@hono/node-server';
import { createDevIssuer } from '@substrat-run/dev-issuer';
import { PERSONAS } from './dev-personas.mjs';

serve({ fetch: createDevIssuer({ personas: PERSONAS }).fetch, hostname: '127.0.0.1', port: 8879 });
console.log('Canopy dev issuer: http://localhost:8879');
