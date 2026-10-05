import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Topbar } from './topbar';

afterEach(cleanup);

it('shows the active space and opens the space picker from the header', () => {
  const onOpenSpaces = vi.fn();
  render(<Topbar breadcrumb={['My Drive']} spaceName="Family" onOpenSpaces={onOpenSpaces} onOpenMenu={vi.fn()} onOpenCmd={vi.fn()} onUpload={vi.fn()} auth={{user:null}} onSignIn={vi.fn()} onSignOut={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name:'Spaces, current: Family'}));
  expect(onOpenSpaces).toHaveBeenCalledOnce();
});
