#!/usr/bin/env node
/* v1.1.6：调试默认禁用，这是唯一的开启方式（npm run start:debug）。
   v1.3.4：复用 scripts/launch.js，让 Windows / Ubuntu 的 SUID 沙箱处理
   与 npm start 完全一致（debug 模式同样不会因 chrome-sandbox 权限崩掉）。 */
'use strict';
const env = Object.assign({}, process.env, {
  HSA_DEBUG: '1',
  HSA_DEBUG_CONSOLE: '1'
});
/* launch.js 里 spawn 用的是传入的 env；这里替换本进程环境后直接调用 */
Object.keys(env).forEach(k => { process.env[k] = env[k]; });
process.exitCode = require('./launch.js').launch({ env });
