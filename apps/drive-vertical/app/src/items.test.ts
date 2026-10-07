import { expect, it } from 'vitest';
import { kindOf } from './items';

it('uses portal file icons for listings without a MIME type', () => {
  expect(kindOf(null, 'photo.HEIC')).toBe('image');
  expect(kindOf(null, 'notes.md')).toBe('note');
  expect(kindOf(null, 'manual.pdf')).toBe('pdf');
  expect(kindOf(null, 'interview.m4a')).toBe('audio');
  expect(kindOf(null, 'clip.mov')).toBe('video');
  expect(kindOf(null, 'unknown.bin')).toBe('doc');
  expect(kindOf('application/pdf', 'misnamed.txt')).toBe('pdf');
});
