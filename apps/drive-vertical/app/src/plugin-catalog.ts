import manifest0 from '../../../../examples/plugins/image-viewer/canopy.json?raw';
import source0 from '../../../../examples/plugins/image-viewer/index.js?raw';
import manifest1 from '../../../../examples/plugins/markdown-editor/canopy.json?raw';
import source1 from '../../../../examples/plugins/markdown-editor/index.js?raw';
import manifest2 from '../../../../examples/plugins/code-editor/canopy.json?raw';
import source2 from '../../../../examples/plugins/code-editor/index.js?raw';
import manifest3 from '../../../../examples/plugins/pdf-viewer/canopy.json?raw';
import source3 from '../../../../examples/plugins/pdf-viewer/index.js?raw';
interface CatalogManifest {id:string;name:string;description:string;capabilities:{kind:string;hosts?:string[]}[]}
function entry(manifest: string, source: string, hosts: string[] = []) {
  const parsed = JSON.parse(manifest) as CatalogManifest;
  if (hosts.length) parsed.capabilities.push({kind:'net:fetch',hosts});
  return {manifest:parsed,source};
}
export const pluginCatalog = [
  entry(manifest0,source0),
  entry(manifest1,source1,['esm.sh','cdn.jsdelivr.net']),
  entry(manifest2,source2,['cdn.jsdelivr.net']),
  entry(manifest3,source3,['cdn.jsdelivr.net']),
];
