import { expect, it, vi } from 'vitest';
import { readOfflineBytes } from './offline-bytes';

it('cancels an unknown-length response as soon as it exceeds the budget', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(12)); }, cancel,
  }));
  await expect(readOfflineBytes(response, 20, 'Too large')).rejects.toThrow('Too large');
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it('preserves bytes at the limit and releases the reader', async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  expect(new Uint8Array(await readOfflineBytes(response, 3, 'Too large'))).toEqual(new Uint8Array([1, 2, 3]));
  expect(response.body?.locked).toBe(false);
});

it('cancels an advertised oversized body without reading it', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '21' } });
  await expect(readOfflineBytes(response, 20, 'Too large')).rejects.toThrow('Too large');
  expect(cancel).toHaveBeenCalledOnce();
});
