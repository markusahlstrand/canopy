import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './sidebar';

afterEach(() => { cleanup(); localStorage.clear(); });

it('keeps space creation reachable when the list is empty', () => {
  const onCreateSpace = vi.fn();
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[]} failed={false} onRetry={vi.fn()} onCreateSpace={onCreateSpace} />);
  expect(screen.getByText('No spaces yet')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  expect(onCreateSpace).toHaveBeenCalledOnce();
});
