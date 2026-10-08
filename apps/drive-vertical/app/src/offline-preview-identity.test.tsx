import { useLayoutEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { OfflinePreview } from './offline-preview';
import * as content from './offline-content';
import type { DriveFile } from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('never commits the previous principal’s saved bytes under the next preview', async () => {
  const file: DriveFile = { id: 'file', folder_id: 'root', name: 'note.txt', current_version_id: 'v1', created_at: '', updated_at: '', deleted_at: null };
  vi.spyOn(content, 'getOfflineFileVersion').mockResolvedValueOnce({
    principal: 'alice', space: 'family', fileId: 'file', versionId: 'v1', name: 'note.txt', mime: 'text/plain',
    bytes: new TextEncoder().encode('Alice private text').buffer, savedAt: 1, pinnedBy: ['root'],
  }).mockImplementation(() => new Promise(() => {}));
  const committed: string[] = [];
  function Preview({ principal }: { principal: string }) {
    useLayoutEffect(() => { committed.push(document.body.textContent ?? ''); }, [principal]);
    return <OfflinePreview file={file} principal={principal} space="family" onClose={() => {}} />;
  }
  const view = render(<Preview principal="alice" />);
  await screen.findByText('Alice private text');
  view.rerender(<Preview principal="bob" />);
  expect(committed.at(-1)).not.toContain('Alice private text');
  expect(screen.queryByText('Alice private text')).toBeNull();
  expect(screen.getByText('Opening saved version…')).toBeTruthy();
});
