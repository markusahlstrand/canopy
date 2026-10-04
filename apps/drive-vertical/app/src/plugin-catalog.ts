import manifest0 from '../../../../examples/plugins/image-viewer/canopy.json?raw';
import source0 from '../../../../examples/plugins/image-viewer/index.js?raw';
import manifest1 from '../../../../examples/plugins/markdown-editor/canopy.json?raw';
import source1 from '../../../../examples/plugins/markdown-editor/index.js?raw';
import manifest2 from '../../../../examples/plugins/code-editor/canopy.json?raw';
import source2 from '../../../../examples/plugins/code-editor/index.js?raw';
import manifest3 from '../../../../examples/plugins/pdf-viewer/canopy.json?raw';
import source3 from '../../../../examples/plugins/pdf-viewer/index.js?raw';
interface CatalogManifest {id:string;name:string;description:string;capabilities:{kind:string;hosts?:string[]}[];contributes?:{viewers?:{match:string[]}[]}}
function entry(manifest: string, source: string, category: 'Viewers' | 'Editors', icon: string, color: string, hosts: string[] = []) {
  const parsed = JSON.parse(manifest) as CatalogManifest;
  if (hosts.length) parsed.capabilities.push({kind:'net:fetch',hosts});
  return {manifest:parsed,source,category,icon,color};
}
export const pluginCatalog = [
  entry(manifest0,source0,'Viewers','image','#3b82f6'),
  entry(manifest1,source1,'Editors','file-text','#8b5cf6',['esm.sh','cdn.jsdelivr.net']),
  entry(manifest2,source2,'Editors','file-code','#10b981',['cdn.jsdelivr.net']),
  entry(manifest3,source3,'Viewers','file-text','#ef4444',['cdn.jsdelivr.net']),
];
/** File extensions and MIME patterns are what people often search for in a viewer catalog. */
export function catalogSearchText(entry: (typeof pluginCatalog)[number]): string {
  return [entry.manifest.name, entry.manifest.description, entry.category,
    ...(entry.manifest.contributes?.viewers?.flatMap(viewer => viewer.match) ?? [])].join(' ').toLocaleLowerCase();
}
