import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProcessingList, ProcessingRun } from './api';

const getProcessing = vi.fn<() => Promise<ProcessingList>>();
vi.mock('./api', () => ({ getProcessing: () => getProcessing() }));

const { ProcessingButton, ProcessingPanel, PROCESSING_ACTIVE_POLL_MS, PROCESSING_IDLE_POLL_MS, runStatus, useProcessing } = await import('./processing');

afterEach(() => { cleanup(); vi.useRealTimers(); getProcessing.mockReset(); });

const run = (o: Partial<ProcessingRun>): ProcessingRun => ({
  id: 'r1', kind: 'label', state: 'queued', manual: true, file: { id: 'f1', name: 'invoice.pdf', folderId: 'root' },
  attempts: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null, nextAttemptAt: null, ...o,
});

describe('what a run says about itself', () => {
  it('names each state in words', () => {
    expect(runStatus(run({ state: 'queued' }))).toBe('Queued');
    expect(runStatus(run({ state: 'running' }))).toBe('Working on it…');
    expect(runStatus(run({ state: 'waiting', waitingFor: 'text' }))).toBe('Waiting for its text to be read');
    expect(runStatus(run({ state: 'retrying', error: 'timed out' }))).toBe('Trying again — timed out');
    expect(runStatus(run({ state: 'failed', error: 'no model' }))).toBe('Failed: no model');
  });

  it('says how a finished run ended', () => {
    expect(runStatus(run({ state: 'done', outcome: 'labelled' }))).toBe('Labelled and described');
    expect(runStatus(run({ state: 'done', outcome: 'skipped:no-text' }))).toBe('Skipped: there is no text to read');
    expect(runStatus(run({ state: 'done', outcome: 'something-new' }))).toBe('Done');
  });
});

describe('the topbar button', () => {
  it('counts what is under way', () => {
    render(<ProcessingButton active={3} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Processing: 3 in progress' }).textContent).toBe('3');
  });

  it('is a plain button when nothing is', () => {
    render(<ProcessingButton active={0} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Processing' }).textContent).toBe('');
  });
});

describe('the panel', () => {
  it('lists what is under way, then what finished, and opens a file from its name', () => {
    const onOpenFile = vi.fn();
    const list: ProcessingList = {
      active: 1,
      runs: [
        run({ id: 'a', state: 'running', kind: 'text' }),
        run({ id: 'b', state: 'done', outcome: 'labelled', endedAt: new Date().toISOString(), file: { id: 'f2', name: 'lease.pdf', folderId: 'root' } }),
      ],
    };
    render(<ProcessingPanel open onOpenChange={() => {}} list={list} error={null} onOpenFile={onOpenFile} />);
    const now = screen.getByRole('region', { name: 'In progress' });
    expect(within(now).getByText('Working on it…')).toBeTruthy();
    expect(within(now).getByText(/Reading the text/)).toBeTruthy();
    const done = screen.getByRole('region', { name: 'Recently finished' });
    expect(within(done).getByText('Labelled and described')).toBeTruthy();
    fireEvent.click(within(done).getByRole('button', { name: 'lease.pdf' }));
    expect(onOpenFile).toHaveBeenCalledWith('f2');
  });

  it('says so when nothing is being processed', () => {
    render(<ProcessingPanel open onOpenChange={() => {}} list={{ runs: [], active: 0 }} error={null} />);
    expect(screen.getByText('Nothing is being processed right now.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Recently finished' })).toBeNull();
  });

  it('keeps the last list when a refresh fails, and says it may be out of date', () => {
    render(<ProcessingPanel open onOpenChange={() => {}} list={{ runs: [run({ state: 'running' })], active: 1 }} error="offline" />);
    expect(screen.getByRole('alert').textContent).toContain('may be out of date: offline');
    expect(screen.getByText('Working on it…')).toBeTruthy();
  });

  it('shows why the list could not be read', () => {
    render(<ProcessingPanel open onOpenChange={() => {}} list={null} error="offline" />);
    expect(screen.getByRole('alert').textContent).toContain('offline');
  });
});

describe('keeping the list fresh', () => {
  function Probe(props: { enabled: boolean; nudge: number; open?: boolean }) {
    const { list } = useProcessing({ enabled: props.enabled, space: 'home', nudge: props.nudge, open: props.open ?? false });
    return <p>{list ? `active ${list.active}` : 'none'}</p>;
  }
  beforeEach(() => vi.useFakeTimers());
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

  it('reads at once, again when nudged, and often only while something is under way', async () => {
    getProcessing.mockResolvedValue({ runs: [run({})], active: 1 });
    const view = render(<Probe enabled nudge={0} />);
    await flush();
    expect(screen.getByText('active 1')).toBeTruthy();
    expect(getProcessing).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(PROCESSING_ACTIVE_POLL_MS); });
    await flush();
    expect(getProcessing).toHaveBeenCalledTimes(2);

    // Done now: the next read slows down to the idle pace.
    getProcessing.mockResolvedValue({ runs: [], active: 0 });
    await act(async () => { vi.advanceTimersByTime(PROCESSING_ACTIVE_POLL_MS); });
    await flush();
    expect(screen.getByText('active 0')).toBeTruthy();
    const calls = getProcessing.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(PROCESSING_ACTIVE_POLL_MS * 3); });
    expect(getProcessing).toHaveBeenCalledTimes(calls);
    await act(async () => { vi.advanceTimersByTime(PROCESSING_IDLE_POLL_MS); });
    expect(getProcessing.mock.calls.length).toBeGreaterThan(calls);

    // Something was just queued: read now, not at the next tick.
    const before = getProcessing.mock.calls.length;
    view.rerender(<Probe enabled nudge={1} />);
    await flush();
    expect(getProcessing).toHaveBeenCalledTimes(before + 1);
  });

  it('lets a read slower than the interval land, rather than starting another over it', async () => {
    const SLOW = PROCESSING_ACTIVE_POLL_MS + 1_000;
    let answer = 0;
    getProcessing.mockImplementation(() => new Promise((resolve) => {
      const n = ++answer;
      setTimeout(() => resolve({ runs: [run({})], active: n }), SLOW);
    }));
    render(<Probe enabled nudge={0} open />);
    await act(async () => { vi.advanceTimersByTime(SLOW); });
    await flush();
    expect(screen.getByText('active 1')).toBeTruthy();
    // Ticks while the next read is out are skipped, so its answer is the one that lands.
    await act(async () => { vi.advanceTimersByTime(PROCESSING_ACTIVE_POLL_MS); });
    expect(getProcessing).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(PROCESSING_ACTIVE_POLL_MS); });
    expect(getProcessing).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(SLOW); });
    await flush();
    expect(screen.getByText('active 2')).toBeTruthy();
  });

  it('reads nothing while signed out or offline', async () => {
    render(<Probe enabled={false} nudge={0} />);
    await act(async () => { vi.advanceTimersByTime(PROCESSING_IDLE_POLL_MS * 2); });
    expect(getProcessing).not.toHaveBeenCalled();
    expect(screen.getByText('none')).toBeTruthy();
  });
});
