import { nodeResolve } from '@rollup/plugin-node-resolve';
import { swc } from 'rollup-plugin-swc3';
import copy from 'rollup-plugin-copy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
export default { input: path.join(dir, 'src/main.ts'), output: { file: path.join(dir, 'dist/js/main.js'), format: 'esm', sourcemap: true }, plugins: [nodeResolve(), swc({ sourceMaps: true, inlineSourcesContent: false }), copy({ targets: [{ src: 'index.html', dest: path.join(dir, 'dist') }] })] };
