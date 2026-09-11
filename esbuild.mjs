import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
  plugins: watch
    ? [{
        name: 'watch-status',
        setup(build) {
          build.onStart(() => console.log('[watch] build started'));
          build.onEnd(() => console.log('[watch] build finished'));
        },
      }]
    : [],
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/index.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    target: 'chrome114',
    format: 'iife',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map(options => esbuild.context(options)));
  await Promise.all(contexts.map(context => context.watch()));
} else {
  await Promise.all(builds.map(options => esbuild.build(options)));
}
