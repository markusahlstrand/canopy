import { afterEach, expect, it, vi } from 'vitest';
import { selectSite } from './api';
import { liveUrl, watchDriveChanges } from './live-updates';

class Socket {
  static opened: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { Socket.opened.push(this); }
}

afterEach(() => {
  Socket.opened = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  selectSite(null);
});

it('addresses the selected site and coalesces live hints while polling through gaps', () => {
  vi.useFakeTimers();
  selectSite('family');
  expect(new URL(liveUrl()).searchParams.get('site')).toBe('family');
  expect(new URL(liveUrl()).protocol).toBe('ws:');

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

it('refreshes within the coalescing window even while live frames keep arriving', () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  const changed = vi.fn();
  const stop = watchDriveChanges(changed);
  const frame = { data: JSON.stringify({ kind: 'change', entityType: 'file' }) };

  for (let i = 0; i < 12; i++) {
    Socket.opened[0]?.onmessage?.(frame);
    vi.advanceTimersByTime(50);
    expect(changed).toHaveBeenCalledTimes(Math.floor((i + 1) / 3));
  }

  Socket.opened[0]?.onmessage?.(frame);
  stop();
  vi.advanceTimersByTime(150);
  expect(changed).toHaveBeenCalledTimes(4);
});

it('backs off short-lived opens to the cap while polling, then resets after a stable connection', () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  const changed = vi.fn();
  const stop = watchDriveChanges(changed);

  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
    const count = Socket.opened.length;
    const socket = Socket.opened[count - 1]!;
    socket.onopen?.();
    vi.advanceTimersByTime(100);
    socket.onclose?.();
    vi.advanceTimersByTime(delay - 1);
    expect(Socket.opened).toHaveLength(count);
    vi.advanceTimersByTime(1);
    expect(Socket.opened).toHaveLength(count + 1);
  }
  expect(changed).toHaveBeenCalledTimes(3);

  const count = Socket.opened.length;
  Socket.opened[count - 1]!.onopen?.();
  vi.advanceTimersByTime(10_000);
  Socket.opened[count - 1]!.onclose?.();
  vi.advanceTimersByTime(999);
  expect(Socket.opened).toHaveLength(count);
  vi.advanceTimersByTime(1);
  expect(Socket.opened).toHaveLength(count + 1);

  Socket.opened[count]!.onopen?.();
  Socket.opened[count]!.onclose?.();
  stop();
  vi.advanceTimersByTime(60_000);
  expect(Socket.opened).toHaveLength(count + 1);
  expect(changed).toHaveBeenCalledTimes(3);
});
