import { expect, it } from 'vitest';
import { textStatusLabel } from './preview';

const row = (status: 'pending' | 'indexed' | 'empty' | 'unsupported' | 'failed', extra: Partial<{ chars: number; truncated: boolean; detail: string | null }> = {}) =>
  ({ id: 'a', file_id: 'f', version_id: 'v', status, chars: 0, truncated: false, extracted_at: null, detail: null, ...extra });

it('says what the kernel extraction found, including a queued read and a cut-off long file', () => {
  expect(textStatusLabel(null)).toMatch(/Nobody has looked/);
  expect(textStatusLabel(row('pending'))).toBe('Reading the text inside this file…');
  expect(textStatusLabel(row('indexed', { chars: 1200 }))).toBe(`${(1200).toLocaleString()} characters, searchable.`);
  expect(textStatusLabel(row('indexed', { chars: 1200, truncated: true }))).toMatch(/the rest of this long file is not/);
  expect(textStatusLabel(row('failed', { detail: 'encrypted' }))).toBe('Extraction failed: encrypted');
});
