// esbuild 构建脚本 — 将 TypeScript 扩展代码打包为单文件
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'], // vscode 模块由宿主提供，不打包
    logLevel: 'info',
  });

  if (watch) {
    console.log('[esbuild] 监听模式已启动...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[esbuild] 构建完成');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
