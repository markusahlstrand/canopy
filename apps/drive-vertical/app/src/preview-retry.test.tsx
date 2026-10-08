import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewPanel } from './preview';
import * as api from './api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const file: api.DriveFile = { id:'file',folder_id:'root',name:'note.txt',current_version_id:'v1',created_at:'',updated_at:'',deleted_at:null };
const version: api.FileVersion = { id:'v1',file_id:'file',mime:'text/plain',size:5,source:'blob',blob_ref:'blob',keep:0,created_at:'' };
function setup() {
  vi.spyOn(api,'listPlugins').mockResolvedValue({plugins:[]});
  vi.spyOn(api,'getFile').mockResolvedValue({file,version,canWrite:true});
  vi.spyOn(api,'fileBodyAsText').mockResolvedValue({text:'hello',truncated:false});
  render(<PreviewPanel fileId="file" onClose={()=>{}} onError={()=>{}}/>);
}
it('retries failed file metadata instead of claiming that the file is empty',async()=>{
  setup(); vi.mocked(api.getFile).mockReset().mockRejectedValueOnce(new Error('Metadata unavailable')).mockResolvedValue({file,version,canWrite:true});
  // Remount so the first metadata read uses the failure fixture.
  cleanup(); render(<PreviewPanel fileId="file" onClose={()=>{}} onError={()=>{}}/>);
  await screen.findByText('Metadata unavailable');
  expect(screen.queryByText('Nothing has been written to this file yet.')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry preview'}));
  await screen.findByText('hello');
});
it('retries a failed current text body without losing the file identity',async()=>{
  vi.spyOn(api,'fileBodyAsText').mockRejectedValueOnce(new Error('Body unavailable')).mockResolvedValue({text:'hello',truncated:false});
  vi.spyOn(api,'listPlugins').mockResolvedValue({plugins:[]});
  vi.spyOn(api,'getFile').mockResolvedValue({file,version,canWrite:true});
  render(<PreviewPanel fileId="file" onClose={()=>{}} onError={()=>{}}/>);
  await screen.findByText('Body unavailable');
  fireEvent.click(screen.getByRole('button',{name:'Retry preview'}));
  await screen.findByText('hello');
  expect(api.fileBodyAsText).toHaveBeenLastCalledWith('file','v1');
});
it('retries failed history and extraction reads within their selected sections',async()=>{
  setup();
  vi.spyOn(api,'fileVersionsPage').mockRejectedValueOnce(new Error('History unavailable')).mockResolvedValue({versions:[version],next:null});
  vi.spyOn(api,'fileText').mockRejectedValueOnce(new Error('Extraction unavailable')).mockResolvedValue(null);
  await screen.findByText('hello');
  fireEvent.click(screen.getByRole('button',{name:'Versions'}));
  await screen.findByText('History unavailable');
  fireEvent.click(screen.getByRole('button',{name:'Retry preview'}));
  await screen.findByText('current');
  fireEvent.click(screen.getByRole('button',{name:'Text'}));
  await screen.findByText('Extraction unavailable');
  fireEvent.click(screen.getByRole('button',{name:'Retry preview'}));
  await screen.findByText('Nobody has looked inside this file yet.');
});
