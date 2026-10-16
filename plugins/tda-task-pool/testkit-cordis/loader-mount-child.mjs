/**
 * P5.6 挂载子进程：真 cordis Loader+Include 挂载行文件 → 插件 apply → 服务就绪。
 * stdout 即证据链（entry applied / config / 自检），由 loader-mount.mjs 断言。
 */
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Include from '@deepseek-ai/cordis-plugin-include';

const bootFile = process.argv[2];
const ctx = new Context();
ctx.plugin(Loader);
await ctx.plugin(Include, { path: pathToFileURL2(bootFile) });
await new Promise((resolve) => setTimeout(resolve, 2000));

function pathToFileURL2(p) {
  return 'file:///' + p.replaceAll('\\', '/').replace(/^\/+/, '');
}
