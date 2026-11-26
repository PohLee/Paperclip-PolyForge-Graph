import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modules = new Map([
  ['../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/product-method-contracts.mjs', 'packs/adlc/product-method-contracts.mjs'],
  ['../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/index.mjs', 'packs/adlc/index.mjs'],
  ['../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/index.mjs', 'packs/adlc-creative-team/index.mjs'],
  ['../../../Paperclip-PolyForge-Graph-Packs/packs/adlc/runtime/host-api.mjs', 'packs/adlc/runtime/host-api.mjs'],
  ['../../../Paperclip-PolyForge-Graph-Packs/packs/adlc-creative-team/runtime/host-api.mjs', 'packs/adlc-creative-team/runtime/host-api.mjs'],
]);

export function trustedPackImportPlugin(packsDir, importer = fileURLToPath(new URL('../src/plugin/trusted-pack-adapters.mjs', import.meta.url))) {
  const root = resolve(packsDir), trustedImporter = resolve(importer);
  return { name: 'trusted-pack-source', setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/Paperclip-PolyForge-Graph-Packs\/packs\/(?:adlc|adlc-creative-team)\/(?:index\.mjs|product-method-contracts\.mjs|runtime\/host-api\.mjs)$/ }, args => {
      if (resolve(args.importer) !== trustedImporter || !modules.has(args.path)) return;
      const path = resolve(root, modules.get(args.path));
      if (args.path.endsWith('/product-method-contracts.mjs') && !existsSync(path)) {
        return { path, namespace: 'optional-adlc-contracts' };
      }
      return { path };
    });
    build.onLoad({ filter: /.*/, namespace: 'optional-adlc-contracts' }, () => ({ contents: 'export {};' }));
  } };
}
