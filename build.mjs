/* 构建：语法 / 导入 / 资源 / 权限校验 → ZIP → 已签名 CRX3。
 * 用法：node build.mjs    （Node >= 18，需要系统 zip 命令） */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const NAME = "human-search-assistant";
fs.mkdirSync(DIST, { recursive: true });

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  if (e.name === "dist" || e.name === ".git") return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const jsFiles = walk(ROOT).filter(p => p.endsWith(".js") || p.endsWith(".mjs"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/* 1) 语法 */
for (const f of jsFiles) {
  const tmp = path.join(DIST, `.check-${crypto.randomBytes(4).toString("hex")}.mjs`);
  fs.writeFileSync(tmp, fs.readFileSync(f));
  try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
  catch (e) {
    console.error(`语法错误：${path.relative(ROOT, f)}\n${e.stderr?.toString() || e.message}`);
    fs.unlinkSync(tmp); process.exit(1);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

/* 2) 相对导入路径 */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1])))
      throw new Error(`${path.relative(ROOT, f)} 引用了不存在的模块 ${m[1]}`);
  }
}

/* 3) manifest 约束：只保留搜索所需权限 */
const manifest = JSON.parse(read("manifest.json"));
if (manifest.manifest_version !== 3) throw new Error("必须使用 Manifest V3");
if (manifest.content_scripts) throw new Error("禁止静态 content_scripts：只允许按作用域 tabId 动态注入");
if (manifest.options_ui) throw new Error("v4 不保留设置选项卡");
for (const k of ["background", "action", "permissions", "host_permissions"])
  if (!manifest[k]) throw new Error(`manifest 缺少 ${k}`);
const REQUIRED_PERMS = ["storage", "alarms", "tabs", "activeTab", "scripting",
  "webNavigation", "debugger", "offscreen"];
const FORBIDDEN_PERMS = ["cookies", "notifications", "proxy", "downloads", "history",
  "bookmarks", "webRequestBlocking"];
for (const p of REQUIRED_PERMS)
  if (!manifest.permissions.includes(p)) throw new Error(`缺少运行所需权限：${p}`);
for (const p of FORBIDDEN_PERMS)
  if (manifest.permissions.includes(p)) throw new Error(`v4 不应再申请权限：${p}`);
const ALLOWED_HOSTS = new Set([
  "https://*.bing.com/*", "https://top.baidu.com/*", "https://weibo.com/*",
  "https://www.toutiao.com/*", "https://www.zhihu.com/*", "https://rss.sina.com.cn/*",
]);
for (const h of manifest.host_permissions)
  if (!ALLOWED_HOSTS.has(h)) throw new Error(`主机权限超出白名单：${h}`);
for (const h of ALLOWED_HOSTS)
  if (!manifest.host_permissions.includes(h)) throw new Error(`缺少默认热搜源权限：${h}`);

/* 3b) v4 架构约束：放弃同步 / Cookie / 任务 / 通知 / 趋势（定时调度本身保留） */
const allSrc = jsFiles
  .filter(p => p.includes(`${path.sep}src${path.sep}`))
  .map(f => [path.relative(ROOT, f), code(path.relative(ROOT, f))]);
const GONE = [
  ["getuserinfo", "官方积分接口"], ["parseDashboard", "积分解析"],
  ["manualCookie", "手动 Cookie"], ["chrome.cookies", "Cookie API"],
  ["chrome.notifications", "系统通知"],
  ["runTasks", "自动完成任务"], ["sync.run", "同步调用"],
  ["FALLBACK_TERMS", "本地词库"], ["SessionChain", "会话链"],
  ["putDaily", "积分历史"], ["options_ui", "设置页"],
];
for (const [rel, src] of allSrc) {
  for (const [bad, label] of GONE)
    if (src.includes(bad)) throw new Error(`${rel} 仍含已放弃的功能：${label}（${bad}）`);
}
// 禁止 SW 动态 import()（w3c/ServiceWorker#1356）
for (const f of jsFiles.filter(p => p.includes("/background/"))) {
  const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (/\bimport\s*\(/.test(src)) throw new Error(`${path.relative(ROOT, f)} 含 SW 禁止的动态 import()`);
}

/* 3c) 搜索次数可设置 */
const setSrc = read("src/lib/settings.js");
for (const need of ["normalizeRepeat", "MIN_ROUNDS = 1", "MAX_ROUNDS = 60",
  "SEARCH_ROUNDS = 12", "out.repeat = normalizeRepeat(out.repeat)"])
  if (!setSrc.includes(need)) throw new Error(`搜索次数未正确实现：${need}`);
if (/out\.repeat\s*=\s*SEARCH_ROUNDS/.test(setSrc))
  throw new Error("搜索次数被强制覆盖为默认值，无法设置");
const popupHtml = read("src/popup/popup.html");
const popupJs = read("src/popup/popup.js");
for (const need of ['id="repeat"', 'id="btnStop"', 'id="btnStart"'])
  if (!popupHtml.includes(need)) throw new Error(`弹窗缺少控件：${need}`);
for (const need of ["config.save", "engine.start", "engine.stop"])
  if (!popupJs.includes(need)) throw new Error(`弹窗缺少交互：${need}`);

/* 3d) 随机热搜、无改写、起始页 Bing 官网 */
const kwSrc = read("src/lib/keywords.js");
if (!kwSrc.includes("HOT_SOURCES") || !kwSrc.includes("rng.shuffle(pool)"))
  throw new Error("必须使用随机真实热搜源");
if (/rewriteQueries\s*:\s*true|sessionChain\s*:\s*true/.test(setSrc))
  throw new Error("查询改写 / 会话链必须关闭");
if (!setSrc.includes("https://www.bing.com/?mkt=zh-CN"))
  throw new Error("起始页必须是 Bing 搜索官网");

/* 3e) 立即停止：AbortSignal + 后台硬闸 */
const utilSrc = read("src/lib/util.js");
const offSrc = read("src/offscreen/offscreen.js");
const swSrc = read("src/background/service-worker.js");
const cdpSrc = read("src/background/cdp.js");
for (const need of ["signal?.aborted", "addEventListener(\"abort\""])
  if (!utilSrc.includes(need)) throw new Error(`sleep 未实现中断：${need}`);
for (const need of ["new AbortController()", "controller?.abort()", "signal", "bail()"])
  if (!offSrc.includes(need)) throw new Error(`引擎缺少立即停止机制：${need}`);
for (const need of ["stopHandled", "scope.halt()", "collector.halt()", "cdp.halt()",
  "releaseScope", "STATE.IDLE"])
  if (!swSrc.includes(need)) throw new Error(`后台缺少立即停止硬闸：${need}`);
if (!cdpSrc.includes("if (halted) throw new Error"))
  throw new Error("CDP 停止后必须拒绝所有输入命令");

/* 3f) 定时自动启动：若干时间点、最多 10 个、每天同点只跑一次 */
const schedSrc = read("src/background/scheduler.js");
for (const need of ["chrome.alarms.create", "chrome.alarms.clear", "handleAlarm",
  "getFired", "markFired", "hhmm()", "BUSY_STATES"])
  if (!schedSrc.includes(need)) throw new Error(`定时调度缺少：${need}`);
if (!swSrc.includes("chrome.alarms.onAlarm") || !swSrc.includes("scheduler.rebuild"))
  throw new Error("后台未接入定时调度");
if (!offSrc.includes("params.auto ? STATE.AUTO : STATE.SEARCH"))
  throw new Error("引擎未区分定时/手动运行状态");
if (!offSrc.includes('"scope.ensure", { background: Boolean(params.auto) }'))
  throw new Error("定时启动应在后台标签页运行，不抢用户焦点");
for (const need of ["normalizeTimes", "MAX_TIMES = 10", "autoRunEnabled", "autoRunTimes"])
  if (!setSrc.includes(need)) throw new Error(`设置缺少定时项：${need}`);
for (const need of ['id="autoEnabled"', 'id="timeInput"', 'id="btnAddTime"', 'id="timeList"'])
  if (!popupHtml.includes(need)) throw new Error(`弹窗缺少定时控件：${need}`);

/* 3g) 工具栏扩展图标配色：搜索进行中（手动/自动）红，其它任何时间蓝 */
const { STATE_META, STATE: ST, BLUE, RED, iconPaths } =
  await import("./src/lib/messages.js");
if (BLUE === RED) throw new Error("蓝色与红色必须不同");
const RED_STATES = new Set([ST.SEARCH, ST.AUTO]);
for (const [name, meta] of Object.entries(STATE_META)) {
  const want = RED_STATES.has(name) ? RED : BLUE;
  if (meta.color !== want)
    throw new Error(`状态 ${name} 工具栏图标颜色应为 ${RED_STATES.has(name) ? "红色" : "蓝色"}`);
}
if (STATE_META.auto?.icon !== "auto_f" || STATE_META.search?.icon !== "search_f")
  throw new Error("手动/自动搜索必须使用各自的红色动画图标");
if (iconPaths(ST.AUTO, 2)["16"] !== "icons/auto_f2_16.png")
  throw new Error("自动搜索图标帧路径不正确");
// 变色必须作用在工具栏 action 上，而不是只改弹窗里的装饰
const stateSrc = read("src/background/state.js");
for (const need of ["chrome.action.setIcon", "chrome.action.setBadgeBackgroundColor"])
  if (!stateSrc.includes(need)) throw new Error(`状态机未改工具栏图标：${need}`);

/* 3h) 搜索方式混合随机：粘贴前清空 / 改词用相关延伸 / 回首页随机 / 无额外选项 */
for (const need of ["cdp.clearInput", "collect.clearInput", "cdp.insertText",
  "collect.related", "suggest.related", "rng.bool(0.38)", "rng.bool(0.42)",
  "searchUrl(keyword)", "modeCount", "el.value = \"\""])
  if (!offSrc.includes(need) && !read("src/background/collector.js").includes(need))
    throw new Error(`混合搜索方式缺少：${need}`);
if (!offSrc.includes("粘贴关键词") || !offSrc.includes("改词·相关延伸"))
  throw new Error("引擎缺少粘贴/改词两种模式");
for (const need of ["collect.clearInput", "collect.related", "suggest.related",
  "cdp.clearInput"])
  if (!swSrc.includes(`"${need}"`)) throw new Error(`后台未注册 RPC：${need}`);
const suggestSrc = read("src/background/suggest.js");
if (!suggestSrc.includes("www.bing.com/AS/Suggestions") || !suggestSrc.includes("return []"))
  throw new Error("相关延伸词必须来自官方联想接口且失败可降级");
// 不得引入任何新的设置项或 UI 选项
for (const bad of ["relatedMode", "clearMode", "homeRate", "searchMode", "id=\"mode"])
  if (setSrc.includes(bad) || popupHtml.includes(bad) || popupJs.includes(bad))
    throw new Error(`不应暴露额外选项：${bad}`);

/* 4) 资源：manifest 引用 + 页面 / 引擎 + 用到的状态图标 */
const assets = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  "src/popup/popup.js", "src/popup/popup.css",
  "src/background/scheduler.js", "src/background/suggest.js",
  "src/offscreen/offscreen.html", "src/offscreen/offscreen.js",
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
const ICON_SIZES = [16, 32, 48, 128];
for (const n of ["idle", "done", "error"])
  for (const s of ICON_SIZES) assets.push(`icons/${n}_${s}.png`);
for (const n of ["search", "auto"])
  for (let f = 0; f < 4; f++)
    for (const s of ICON_SIZES) assets.push(`icons/${n}_f${f}_${s}.png`);
for (const p of new Set(assets))
  if (!fs.existsSync(path.join(ROOT, p))) throw new Error(`引用的资源不存在：${p}`);
console.log(`✓ manifest / 权限 / ${jsFiles.length} 个 JS / ${new Set(assets).size} 项资源检查通过`);

/* 5) ZIP（解压即可「加载已解压的扩展程序」） */
const zipPath = path.join(DIST, `${NAME}.zip`);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
execSync(`zip -r -q "${zipPath}" . -x 'dist/*' '.git/*' '*.pem' 'tests/*' 'tools/*'`,
  { cwd: ROOT, stdio: "pipe" });
const zipBytes = fs.readFileSync(zipPath);
console.log(`✓ ${path.basename(zipPath)}  ${(zipBytes.length / 1024).toFixed(1)} KB`);

/* 6) CRX3 签名 */
const keyPath = path.join(DIST, "key.pem");
let privateKey;
if (fs.existsSync(keyPath)) privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
else {
  const { privateKey: k } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = k;
  fs.writeFileSync(keyPath, k.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
}
const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
const varint = n => { const o = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Buffer.from(o); };
const field = (no, buf) => Buffer.concat([varint((no << 3) | 2), varint(buf.length), buf]);
const proof = (pk, sig) => Buffer.concat([field(1, pk), sig ? field(2, sig) : Buffer.alloc(0)]);
const header = proofs => Buffer.concat(proofs.map(p => field(2, p)));
const signedHeaderData = header([proof(publicKey, null)]);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const signedData = Buffer.concat([
  Buffer.from("CRX3 Signed Data\0", "ascii"), u32(signedHeaderData.length), signedHeaderData, zipBytes,
]);
const signature = crypto.sign("RSA-SHA256", signedData, privateKey);
const fileHeader = header([proof(publicKey, signature)]);
const crx = Buffer.concat([
  Buffer.from("Cr24", "ascii"), u32(3), u32(fileHeader.length), fileHeader, zipBytes,
]);
fs.writeFileSync(path.join(DIST, `${NAME}.crx`), crx);
const crxId = [...crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join("");
fs.writeFileSync(path.join(DIST, "extension-id.txt"), crxId + "\n");
console.log(`✓ ${NAME}.crx  ${(crx.length / 1024).toFixed(1)} KB`);
console.log(`✓ Extension ID: ${crxId}`);
console.log("\n完成：dist/ 内 ZIP 可直接解压加载；CRX 为已签名 CRX3。");
