import { afterEach, expect, it, vi } from 'vitest';
import { selectSite } from './api';
import { liveUrl, watchDriveChanges } from './live-updates';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  selectSite(null);
});

it('addresses the selected site and coalesces live hints while polling through gaps', () => {
  vi.useFakeTimers();
  selectSite('family');
  expect(new URL(liveUrl()).searchParams.get('site')).toBe('family');
  expect(new URL(liveUrl()).protocol).toBe('ws:');

  class Socket {
    static opened: Socket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) { Socket.opened.push(this); }
  }
  vi.stubGlobal('WebSocket', Socket);
  const changed = vi.fn();
  const stop = watchDriveChanges(changed);
  expect(Socket.opened[0]?.url).toBe(liveUrl());

  Socket.opened[0]?.onmessage?.({ data: JSON.stringify({ kind: 'change', entityType: 'file' }) });
  Socket.opened[0]?.onmessage?.({ data: JSON.stringify({ kind: 'change', entityType: 'folder' }) });
  Socket.opened[0]?.onmessage?.({ data: JSON.stringify({ kind: 'unknown' }) });
  vi.advanceTimersByTime(150);
  expect(changed).toHaveBeenCalledTimes(1);

  Socket.opened[0]?.onclose?.();
  vi.advanceTimersByTime(1_000);
  expect(Socket.opened).toHaveLength(2);
  vi.advanceTimersByTime(60_000);
  vi.advanceTimersByTime(150);
  expect(changed).toHaveBeenCalledTimes(2);

  stop();
  expect(Socket.opened[1]?.close).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000);
  expect(changed).toHaveBeenCalledTimes(2);
});
