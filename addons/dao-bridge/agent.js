// dao-bridge 独立后端 Agent（纯 Node，无 VS Code 依赖）
// 道法自然 · 去中心化：本机起服务 + 隧道出站，云端直达本机。
// 两种穿透模式（DAO_TUNNEL 切换）：
//   - cloudflare（默认）：cloudflared 快速隧道，零账号、URL 动态（*.trycloudflare.com，重启会变）。
//   - tailscale：固定 URL（*.ts.net / MagicDNS），经 tailscale serve 把本机端口暴露到 tailnet，URL 永不变。
// 配置优先级：环境变量 > 同目录 conn.json > 默认值。token 不入库，仅存本机 conn.json。
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require('./core.js');

const DIR = __dirname;
const CONN = path.join(DIR, 'conn.json');
const TRY_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
// 隧道模式归一化：tailscale / ts / fixed → 'tailscale'，其余一律 'cloudflare'。
function normTunnel(v) {
  return /^(tailscale|ts|fixed)$/i.test(String(v || '').trim()) ? 'tailscale' : 'cloudflare';
}

function loadConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONN, 'utf8')); } catch {}
  return {
    token: process.env.DAO_TOKEN || c.token || '',
    port: Number(process.env.DAO_PORT || c.port || 9920),
    root: process.env.DAO_ROOT || c.root || os.homedir(),
    cloudflared: process.env.DAO_CLOUDFLARED || c.cloudflared || 'cloudflared',
    proxy: process.env.DAO_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || c.proxy || '',
    // 穿透模式：cloudflare（动态 URL）| tailscale（固定 URL）
    tunnel: normTunnel(process.env.DAO_TUNNEL || c.tunnel || 'cloudflare'),
    // tailscale 模式：可执行路径 + 固定公网 URL 覆盖（留空则自动从 tailscale status 推导）
    tailscale: process.env.DAO_TAILSCALE || c.tailscale || 'tailscale',
    fixedUrl: process.env.DAO_PUBLIC_URL || c.fixedUrl || '',
    // 是否自动跑 `tailscale serve` 把本机端口暴露到 tailnet（默认开；设 0/false 关闭，自行 serve）
    tsServe: !/^(0|false|no|off)$/i.test(String(process.env.DAO_TS_SERVE ?? c.tsServe ?? '1')),
  };
}

// 通用适配:无显式代理时,在 Windows 上探测系统代理(很多内网/翻墙机走本地代理才能出网)
function detectProxy(conf) {
  if (conf.proxy) return conf.proxy;
  if (process.platform !== 'win32') return '';
  try {
    const base = 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ';
    const en = cp.execSync(base + 'ProxyEnable', { encoding: 'utf8' });
    if (!/0x1\b/.test(en)) return '';
    const sv = cp.execSync(base + 'ProxyServer', { encoding: 'utf8' });
    const m = sv.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!m) return '';
    let val = m[1].trim();
    if (val.includes('=')) {
      const hit = val.split(';').map(s => s.trim()).find(s => /^https?=/.test(s));
      val = hit ? hit.split('=')[1] : '';
    }
    return val ? ('http://' + val.replace(/^https?:\/\//, '')) : '';
  } catch { return ''; }
}

// 启动 cloudflared 快速隧道（零账号、临时 URL），回调拿到公网 URL。断开自动重启。
function startQuickTunnel(conf, port, onUrl) {
  let proc = null, stopped = false, url = '';
  const env = Object.assign({}, process.env);
  delete env.NO_PROXY; delete env.no_proxy;
  if (conf.proxy) { env.HTTPS_PROXY = conf.proxy; env.HTTP_PROXY = conf.proxy; env.https_proxy = conf.proxy; env.http_proxy = conf.proxy; }
  const spawn = () => {
    if (stopped) return;
    const args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:' + port];
    try { proc = cp.spawn(conf.cloudflared, args, { windowsHide: true, env }); }
    catch (e) { console.error('[dao-bridge] cloudflared 启动失败: ' + (e && e.message)); setTimeout(spawn, 5000); return; }
    const onData = (buf) => {
      const m = buf.toString().match(TRY_RE);
      if (m && m[0] !== url) { url = m[0]; onUrl(url); }
    };
    if (proc.stdout) proc.stdout.on('data', onData);
    if (proc.stderr) proc.stderr.on('data', onData);
    proc.on('exit', () => { url = ''; if (!stopped) { console.log('[dao-bridge] 隧道断开，5s 后重连…'); setTimeout(spawn, 5000); } });
  };
  spawn();
  return { stop() { stopped = true; try { proc && proc.kill(); } catch {} }, currentUrl: () => url };
}

// 启动 tailscale 固定隧道：经 tailnet 的 MagicDNS 名暴露本机端口，URL 永不变。
// 1) 若未显式给 fixedUrl，则从 `tailscale status --json` 读 Self.DNSName 推导 https URL；
// 2) 默认跑 `tailscale serve --bg --https=443 http://127.0.0.1:<port>` 把 443 反代到本机端口。
function startTailscaleTunnel(conf, port, onUrl) {
  const ts = conf.tailscale;
  const run = (args) => cp.execFileSync(ts, args, { encoding: 'utf8', windowsHide: true });
  let url = conf.fixedUrl;
  if (!url) {
    try {
      const st = JSON.parse(run(['status', '--json']));
      const dns = st && st.Self && st.Self.DNSName;
      if (dns) url = 'https://' + String(dns).replace(/\.$/, '');
    } catch (e) {
      console.error('[dao-bridge] 读取 tailscale 状态失败（确认已安装并 `tailscale up` 登录）: ' + (e && e.message));
    }
  }
  if (conf.tsServe) {
    try {
      run(['serve', '--bg', '--https=443', 'http://127.0.0.1:' + port]);
      console.log('[dao-bridge] tailscale serve: https://<MagicDNS>:443 -> http://127.0.0.1:' + port);
    } catch (e) {
      console.error('[dao-bridge] `tailscale serve` 失败（需 tailnet 开启 MagicDNS+HTTPS，或自行 serve）: ' + (e && e.message));
    }
  }
  if (url) onUrl(url.replace(/\/$/, ''));
  else console.error('[dao-bridge] 未能确定固定 URL：请设 DAO_PUBLIC_URL=https://<host>.ts.net 或确保 tailscale 已登录');
  return {
    stop() { if (conf.tsServe) { try { run(['serve', '--https=443', 'off']); } catch {} } },
    currentUrl: () => url || '',
  };
}

(async () => {
  const conf = loadConf();
  if (!conf.token) { console.error('[dao-bridge] 缺 token：设 DAO_TOKEN 或在 conn.json 写 token'); process.exit(1); }
  conf.proxy = detectProxy(conf);
  let publicUrl = '';
  const host = {
    workspaceRoot: () => conf.root,
    info: () => ({ host: os.hostname(), platform: process.platform, workspace: [conf.root] }),
    publicUrl: () => publicUrl,
    log: (m) => console.log('[dao-bridge] ' + m),
  };
  const server = await core.startServer(host, { port: conf.port, token: conf.token });
  if (conf.proxy) console.log('[dao-bridge] proxy=' + conf.proxy);

  const persist = () => {
    try {
      fs.writeFileSync(CONN, JSON.stringify({
        token: conf.token, port: server.port, root: conf.root, host: os.hostname(),
        publicUrl, updated: new Date().toISOString(),
      }, null, 2));
    } catch {}
  };

  const onUrl = (u) => {
    publicUrl = u;
    persist();
    console.log('[dao-bridge] 公网入口: ' + u + '  (Authorization: Bearer <token>)');
  };
  const tunnel = conf.tunnel === 'tailscale'
    ? startTailscaleTunnel(conf, server.port, onUrl)
    : startQuickTunnel(conf, server.port, onUrl);

  persist();
  setInterval(persist, 5000);

  console.log('[dao-bridge] host=' + os.hostname() + ' port=' + server.port + ' tunnel=' + conf.tunnel);
  console.log(conf.tunnel === 'tailscale'
    ? '[dao-bridge] tailscale 固定隧道：URL 永不变（*.ts.net），云端 tailnet 内直达'
    : '[dao-bridge] cloudflared 快速隧道启动中… 拿到 URL 后即打印公网入口（重启会变）');
  process.on('SIGINT', () => { tunnel.stop(); process.exit(0); });
  process.stdin.resume();
})();
