#!/usr/bin/env node
/**
 * lens-via-pc.mjs —— 借一台局域网 PC 的浏览器跑 Lens（可选方案）
 *
 * 为什么需要它：
 *   容器 / 服务器里的无头浏览器过不了 Google 的人机验证（captcha），
 *   而 Lens 对真人 coser 的识别最准。所以把图传到一台带 Edge/Chrome 的 PC 上，
 *   在那边用真浏览器执行 bin/fish.mjs，再把 JSON 结果拿回来。
 *
 * 不写死任何地址，全部走环境变量：
 *   FISH_PC_HOST    目标 PC 的 IP / 主机名（必填）
 *   FISH_PC_USER    SSH 用户名（必填）
 *   FISH_PC_KEY     SSH 私钥路径（必填）
 *   FISH_PC_PORT    SSH 端口（默认 22）
 *   FISH_PC_ROOT    远端放图片的目录，如 D:/fish-find/inbox（必填）
 *   FISH_PC_APP     远端本仓库根目录，如 D:/fish-find（必填，里面要有 bin/fish.mjs）
 *
 * 用法：
 *   FISH_PC_HOST=192.168.1.50 FISH_PC_USER=me FISH_PC_KEY=~/.ssh/id_ed25519 \
 *   FISH_PC_ROOT=D:/fish-find/inbox FISH_PC_APP=D:/fish-find \
 *   node remote/lens-via-pc.mjs 图片.jpg [--json]
 *
 * 前置：PC 开启 OpenSSH Server、装 Node.js ≥ 20、本仓库已放到 FISH_PC_APP。
 *
 * 退出码：0 成功 / 2 PC 不可达 / 3 查询失败
 */
import fs from 'node:fs';
import path from 'node:path';

// ssh2 是唯一的可选依赖（远程借壳才需要），没装时给明确提示
let Client;
try {
  ({ Client } = await import('ssh2'));
} catch {
  console.log('缺依赖 ssh2：远程借壳需要先 npm i ssh2');
  process.exit(1);
}

const HOST = process.env.FISH_PC_HOST;
const USER = process.env.FISH_PC_USER;
const KEY = process.env.FISH_PC_KEY;
const PORT = Number(process.env.FISH_PC_PORT || 22);
const ROOT = process.env.FISH_PC_ROOT;
const APP = process.env.FISH_PC_APP;
const TIMEOUT = 90;

const missing = [['FISH_PC_HOST', HOST], ['FISH_PC_USER', USER], ['FISH_PC_KEY', KEY], ['FISH_PC_ROOT', ROOT], ['FISH_PC_APP', APP]].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.log('缺环境变量：' + missing.join(', ') + '\n（见文件头用法说明）');
  process.exit(1);
}

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--'));
const asJson = argv.includes('--json');
if (!src) { console.log('用法：node remote/lens-via-pc.mjs <图片路径> [--json]'); process.exit(1); }
if (!src.startsWith('http') && !fs.existsSync(src)) { console.log('图找不到：' + src); process.exit(1); }

// 远端文件名只留 ASCII，避免中文/空格在 cmd 里出岔子
const ext = (path.extname(src) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
const remoteImg = `${ROOT.replace(/[\\/]+$/, '')}/f-${Date.now()}${ext}`;
const remoteWin = remoteImg.replace(/\//g, '\\');
const appWin = APP.replace(/\//g, '\\').replace(/[\\]+$/, '');

const conn = new Client();
let done = false;
const timer = setTimeout(() => { if (!done) { conn.end(); fail('PC 链路超时（' + TIMEOUT + 's）', 3); } }, TIMEOUT * 1000);

function fail(msg, code) {
  done = true; clearTimeout(timer);
  try { conn.end(); } catch {}
  console.log('🐟 ' + msg);
  process.exit(code);
}

conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) return fail('PC 上拿不到 sftp：' + err.message, 2);
    const mk = (p) => new Promise((r) => sftp.mkdir(p, () => r()));
    mk(ROOT).then(() => {
      sftp.fastPut(src, remoteImg, (e2) => {
        if (e2) return fail('图片传到 PC 失败：' + e2.message, 2);
        const cmd = `cd /d ${appWin} && node bin\\fish.mjs "${remoteWin}" --engines lens --json`;
        conn.exec(cmd, (e3, stream) => {
          if (e3) return fail('PC 上启动命令失败：' + e3.message, 3);
          let out = '', errOut = '';
          stream.on('data', (d) => { out += d.toString(); });
          stream.stderr.on('data', (d) => { errOut += d.toString(); });
          stream.on('close', () => {
            done = true; clearTimeout(timer);
            try { conn.end(); } catch {}
            render(out, errOut);
          });
        });
      });
    });
  });
}).on('error', (e) => fail('连不上目标 PC：' + e.message, 2))
  .connect({ host: HOST, port: PORT, username: USER, privateKey: fs.readFileSync(KEY), readyTimeout: 15000 });

function render(out, errOut) {
  let r = null;
  const s = out.indexOf('{');
  if (s >= 0) { try { r = JSON.parse(out.slice(s, out.lastIndexOf('}') + 1)); } catch {} }
  if (!r) {
    const hint = (out || errOut || '').trim().split('\n').slice(-2).join(' ').slice(0, 120);
    console.log('🐟 PC 上没跑出结果' + (hint ? '：' + hint : ''));
    process.exit(3);
  }
  if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const acc = Array.isArray(r.accounts) ? r.accounts : [];
  if (acc.length === 0) { console.log('🐟 没找到。这张图 Lens 也没对上。'); process.exit(0); }
  const best = acc[0];
  console.log('🐟 鱼鱼找鸡结果（PC · Lens）' + (r.elapsedMs ? `（${(r.elapsedMs / 1000).toFixed(1)} 秒）` : ''));
  console.log('🌐 平台：' + (best.platform || '?'));
  console.log('👤 名字：' + (best.authorName || best.handle || '?'));
  console.log('🆔 账号：' + (best.handle || '') + (best.url ? ' · ' + best.url : ''));
  process.exit(0);
}
