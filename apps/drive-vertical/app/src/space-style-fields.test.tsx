import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpaceStyleFields } from './space-style-fields';

afterEach(cleanup);

it('offers the same visible icon and color choices during creation and editing', () => {
  const onIcon = vi.fn(), onColor = vi.fn();
  render(<SpaceStyleFields icon="folder" color="#3b82f6" onIcon={onIcon} onColor={onColor} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose space icon and color' }));
  fireEvent.click(screen.getByRole('button', { name: 'Icon home' }));
  fireEvent.click(screen.getByRole('button', { name: 'Color #10b981' }));
  expect(onIcon).toHaveBeenCalledWith('home');
  expect(onColor).toHaveBeenCalledWith('#10b981');
});
