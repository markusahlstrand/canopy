import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileDropZone } from './file-drop-zone';
afterEach(cleanup);
function transfer(types = ['Files']) { return { types, files: [new File(['a'], 'a.txt')], items: [], dropEffect: '' }; }
it('names the destination and sends an external file batch once', () => {
  const onFiles = vi.fn();
  render(<FileDropZone disabled={false} destination="Papers" onFiles={onFiles} onError={() => {}}>List</FileDropZone>);
  const zone = screen.getByLabelText('File upload area');
  const dataTransfer = transfer();
  fireEvent.dragEnter(zone, { dataTransfer });
  expect(screen.getByRole('status').textContent).toBe('Drop files into Papers');
  fireEvent.drop(zone, { dataTransfer });
  expect(onFiles).toHaveBeenCalledOnce();
  expect(onFiles.mock.calls[0]![0][0].name).toBe('a.txt');
  expect(screen.queryByRole('status')).toBeNull();
});
it('ignores internal moves and blocks file drops in a disabled view', () => {
  const onFiles = vi.fn();
  const props = { destination: 'Root', onFiles, onError: vi.fn() };
  const view = render(<FileDropZone {...props} disabled={false}>List</FileDropZone>);
  const zone = screen.getByLabelText('File upload area');
  fireEvent.dragEnter(zone, { dataTransfer: transfer(['application/x-canopy-file']) });
  fireEvent.drop(zone, { dataTransfer: transfer(['application/x-canopy-file']) });
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<FileDropZone {...props} disabled>List</FileDropZone>);
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer() });
  fireEvent(zone, event);
  expect(event.defaultPrevented).toBe(true);
  expect(onFiles).not.toHaveBeenCalled();
});
it('rejects directory drops with an explicit explanation', () => {
  const onFiles = vi.fn(); const onError = vi.fn();
  render(<FileDropZone disabled={false} destination="Root" onFiles={onFiles} onError={onError}>List</FileDropZone>);
  fireEvent.drop(screen.getByLabelText('File upload area'), { dataTransfer: { ...transfer(), items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] } });
  expect(onFiles).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('Folder uploads are not supported'));
});
