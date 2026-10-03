import manifest0 from '../../../../examples/plugins/image-viewer/canopy.json?raw';
import source0 from '../../../../examples/plugins/image-viewer/index.js?raw';
import manifest1 from '../../../../examples/plugins/markdown-editor/canopy.json?raw';
import source1 from '../../../../examples/plugins/markdown-editor/index.js?raw';
import manifest2 from '../../../../examples/plugins/code-editor/canopy.json?raw';
import source2 from '../../../../examples/plugins/code-editor/index.js?raw';
import manifest3 from '../../../../examples/plugins/pdf-viewer/canopy.json?raw';
import source3 from '../../../../examples/plugins/pdf-viewer/index.js?raw';
export const pluginCatalog = [{manifest:JSON.parse(manifest0) as {id:string;name:string;description:string;capabilities:{kind:string;hosts?:string[]}[]},source:source0},{manifest:JSON.parse(manifest1) as {id:string;name:string;description:string;capabilities:{kind:string;hosts?:string[]}[]},source:source1},{manifest:JSON.parse(manifest2) as {id:string;name:string;description:string;capabilities:{kind:string;hosts?:string[]}[]},source:source2},{manifest:JSON.parse(manifest3) as {id:string;name:string;description:string;capabilities:{kind:string;hosts?:string[]}[]},source:source3}];
