import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { ArduinoContext, SketchFolder } from './arduino-api';

const ARDUINO_API_EXT = 'dankeboy36.vscode-arduino-api';
const STATE_IP = 'espOta.lastIp';
const STATE_PWD = 'espOta.password';
const LOG_FILE = path.join(os.tmpdir(), 'esp-ota.log');

let channel: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let busy = false;

// ---------------------------------------------------------------- 日志

function log(msg: string) {
  channel?.appendLine(msg);
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\r\n`);
  } catch {
    /* ignore */
  }
}

function setStatus(text: string, tooltip: string) {
  if (!statusItem) return;
  statusItem.text = text;
  statusItem.tooltip = tooltip;
}

// ---------------------------------------------------------------- 工具定位

/**
 * 在 Arduino15 里找 espota。
 * 关键：ESP8266 必须用 esp8266 核心自带的 espota.py ——
 * ESP32 的 espota.exe 和 ESP8266 的认证流程不兼容，会报
 * "No Answer to our Authentication"。
 * 所以优先取 chip 对应平台的那一份。
 */
function findEspota(chip?: 'esp32' | 'esp8266'): { exe: string; isPy: boolean } | undefined {
  const home = os.homedir();
  const bases = [
    path.join(home, 'AppData', 'Local', 'Arduino15', 'packages'),
    path.join(home, '.arduino15', 'packages'),
    path.join(home, 'Library', 'Arduino15', 'packages'),
  ];

  const candidates: { exe: string; isPy: boolean }[] = [];

  // 目标芯片对应的平台排在最前面
  const order: string[] = chip === 'esp8266' ? ['esp8266', 'esp32']
                       : chip === 'esp32'   ? ['esp32', 'esp8266']
                       : ['esp32', 'esp8266'];

  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const pkg of order) {
      const hw = path.join(base, pkg, 'hardware', pkg);
      if (!fs.existsSync(hw)) continue;
      let versions: string[] = [];
      try {
        versions = fs.readdirSync(hw).sort().reverse();
      } catch {
        continue;
      }
      for (const v of versions) {
        for (const [file, isPy] of [
          ['espota.exe', false],
          ['espota.py', true],
        ] as [string, boolean][]) {
          const p = path.join(hw, v, 'tools', file);
          if (fs.existsSync(p)) candidates.push({ exe: p, isPy });
        }
      }
    }
  }

  if (chip === 'esp8266') {
    // ESP8266 用 .py（.exe 那份是 ESP32 的，认证不兼容）
    const py = candidates.find((c) => c.isPy && c.exe.includes('esp8266'));
    if (py) return py;
  }
  return candidates.find((c) => !c.isPy) ?? candidates[0];
}

function findPython(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function findArduinoCli(): string | undefined {
  const c = 'C:\\Program Files\\Arduino IDE\\resources\\app\\lib\\backend\\resources\\arduino-cli.exe';
  if (fs.existsSync(c)) return c;
  return 'arduino-cli';
}

/**
 * 按 IP 查芯片型号，决定 OTA 端口。
 * ESP8266 用 8266，ESP32 用 3232；猜错端口 espota 会重试 10 次（约 100 秒）。
 * `arduino-cli board list` 不受 IDE 运行影响，能直接给出 IP → FQBN 的映射。
 */
async function detectChip(ip: string): Promise<'esp32' | 'esp8266' | undefined> {
  const cli = findArduinoCli();
  if (!cli) return undefined;
  const r = await run(cli, ['board', 'list', '--format', 'json']);
  if (r.code !== 0) {
    log(`board list 失败: ${r.code}`);
    return undefined;
  }
  try {
    const j = JSON.parse(r.out);
    for (const p of j.detected_ports ?? []) {
      if ((p.port?.address ?? '') !== ip) continue;
      const fqbn: string = p.matching_boards?.[0]?.fqbn ?? '';
      log(`芯片识别: ${ip} → ${fqbn || '(未知)'}`);
      if (fqbn.includes('esp8266')) return 'esp8266';
      if (fqbn.includes('esp32')) return 'esp32';
    }
  } catch (e) {
    log(`board list 解析失败: ${e}`);
  }
  return undefined;
}

function portForChip(chip?: 'esp32' | 'esp8266'): number | undefined {
  if (chip === 'esp8266') return 8266;
  if (chip === 'esp32') return 3232;
  return undefined;
}

async function detectPortForIp(ip: string): Promise<number | undefined> {
  const cli = findArduinoCli();
  if (!cli) return undefined;
  const r = await run(cli, ['board', 'list', '--format', 'json']);
  if (r.code !== 0) {
    log(`board list 失败: ${r.code}`);
    return undefined;
  }
  try {
    const j = JSON.parse(r.out);
    for (const p of j.detected_ports ?? []) {
      if ((p.port?.address ?? '') !== ip) continue;
      const fqbn: string = p.matching_boards?.[0]?.fqbn ?? '';
      log(`芯片识别: ${ip} → ${fqbn || '(未知)'}`);
      if (fqbn.includes('esp8266')) return 8266;
      if (fqbn.includes('esp32')) return 3232;
    }
  } catch (e) {
    log(`board list 解析失败: ${e}`);
  }
  return undefined;
}

// ---------------------------------------------------------------- sketch 定位

function pickSketch(api: ArduinoContext | undefined): SketchFolder | undefined {
  const fromApi = api?.currentSketch ?? api?.openedSketches?.[0];
  if (fromApi?.sketchPath) return fromApi;

  // Arduino IDE 2.3.x 的 API 有时拿不到 currentSketch，退回当前编辑器
  const file = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (file) return { sketchPath: path.dirname(file) } as SketchFolder;

  const wf = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (wf) return { sketchPath: wf } as SketchFolder;

  return undefined;
}

/**
 * 从 IDE 的构建缓存里找固件。
 *
 * 注意：绝不能在 IDE 运行时自己调 arduino-cli compile ——
 * IDE 的 daemon 占着 CLI 锁，外部编译会一直卡住。
 */
function findFirmware(sketchDir: string, summary?: { buildPath?: string }): string | undefined {
  const name = path.basename(sketchDir);

  if (summary?.buildPath) {
    const p = path.join(summary.buildPath, `${name}.ino.bin`);
    if (fs.existsSync(p)) return p;
  }

  const home = os.homedir();
  const roots = [
    path.join(home, 'AppData', 'Local', 'arduino', 'sketches'),
    path.join(os.tmpdir(), 'arduino', 'sketches'),
    path.join(home, '.cache', 'arduino', 'sketches'),
    path.join(home, 'Library', 'Caches', 'arduino', 'sketches'),
  ];

  let best: string | undefined;
  let bestTime = 0;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = path.join(root, d, `${name}.ino.bin`);
      try {
        if (!fs.existsSync(p)) continue;
        const t = fs.statSync(p).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = p;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- 进程

function run(exe: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '';
    const push = (b: Buffer) => {
      out += b.toString();
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e) => resolve({ code: -1, out: out + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

function parsePercent(s: string): number | undefined {
  const m = s.match(/(\d{1,3})%/g);
  if (!m) return undefined;
  const n = parseInt(m[m.length - 1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function isAuthFailure(out: string): boolean {
  return /Authentication Failed|check your password/i.test(out);
}

// ---------------------------------------------------------------- 交互

function defaultPortFor(sketch: SketchFolder | undefined): number {
  const fqbn = sketch?.fqbn ?? '';
  return fqbn.includes('esp8266') ? 8266 : 3232;
}

async function askIp(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const last = ctx.globalState.get<string>(STATE_IP, '');
  const ip = await vscode.window.showInputBox({
    title: 'OTA 目标 IP（1/2）',
    prompt: 'ESP 设备的局域网 IP（会记住上次输入）',
    value: last,
    placeHolder: '例如 192.168.1.50',
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return '不能为空';
      return /^\d{1,3}(\.\d{1,3}){3}$/.test(t) ? undefined : 'IP 格式不对';
    },
  });
  if (!ip) return undefined;
  const t = ip.trim();
  await ctx.globalState.update(STATE_IP, t);
  return t;
}

async function askPassword(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const saved = ctx.globalState.get<string>(STATE_PWD, '');
  const p = await vscode.window.showInputBox({
    title: 'OTA 密码（2/2）',
    prompt: saved
      ? '已保存密码，直接回车沿用；重新输入可覆盖；输入 - 清除'
      : '没有密码就直接回车；输入 - 也表示无密码',
    password: true,
    value: saved,
    ignoreFocusOut: true,
  });
  if (p === undefined) return undefined;

  const v = p.trim();
  const final = v === '-' ? '' : p;
  await ctx.globalState.update(STATE_PWD, final);
  return final;
}

// ---------------------------------------------------------------- 主流程

async function upload(ctx: vscode.ExtensionContext) {
  if (busy) {
    vscode.window.showInformationMessage('OTA 正在进行中…');
    return;
  }
  busy = true;
  setStatus('$(sync~spin) OTA', '正在准备 OTA…');

  try {
    const api: ArduinoContext | undefined = vscode.extensions.getExtension(ARDUINO_API_EXT)?.exports;
    log('');
    log('================ ESP OTA ================');

    const sketch = pickSketch(api);
    if (!sketch) {
      vscode.window.showErrorMessage('没有打开的 sketch：请先打开 .ino 文件');
      return;
    }
    log(`sketch: ${sketch.sketchPath}`);

    const cfg = vscode.workspace.getConfiguration('espOta');
    let password = ctx.globalState.get<string>(STATE_PWD) ?? cfg.get<string>('password', '');
    const portCfg = cfg.get<number>('port', 0);

    const fw = findFirmware(sketch.sketchPath, sketch.compileSummary);
    if (!fw) {
      const msg = '找不到编译产物，请先按 Ctrl+R 编译一次再上传';
      log(msg);
      vscode.window.showErrorMessage(msg);
      return;
    }
    log(`固件: ${fw} (${(fs.statSync(fw).size / 1024).toFixed(0)} KB)`);

    const ip = await askIp(ctx);
    if (!ip) return;

    // 紧接着问密码：已保存的会预填，直接回车沿用
    const pwdInput = await askPassword(ctx);
    if (pwdInput === undefined) return;
    password = pwdInput;

    // 端口优先级：设置里的固定值 > 该 IP 上次成功的端口 > 按芯片自动识别 > 默认 3232
    const otherPort = (p: number) => (p === 8266 ? 3232 : 8266);
    let detected: number | undefined;
    let chip: 'esp32' | 'esp8266' | undefined;
    let port = portCfg > 0 ? portCfg : ctx.globalState.get<number>(`espOta.port.${ip}`, 0);
    if (!port) {
      chip = await detectChip(ip);
      detected = portForChip(chip);
      port = detected ?? defaultPortFor(sketch);
      log(`端口: ${port}${detected ? '（按芯片识别）' : '（默认值）'}`);
    } else {
      log(`端口: ${port}${portCfg > 0 ? '（设置固定）' : '（该 IP 上次成功过）'}`);
    }

    // espota 要在知道芯片之后才能选（ESP8266 必须用它自己核心里的那份）
    const espota = findEspota(chip);
    if (!espota) {
      vscode.window.showErrorMessage('找不到 espota，请确认已安装 ESP32 / ESP8266 开发板支持');
      return;
    }
    log(`espota: ${espota.exe}${espota.isPy ? ' (python)' : ''}`);

    const doUpload = async (pwd: string, usePort: number) => {
      // 两代 espota 的参数不一样：
      //   ESP32 版：-t 超时 / -r 传完重启
      //   ESP8266 版（老脚本）：没有 -t，-r 是「显示进度」不是重启
      // 用错会直接报 "no such option: -t"，所以按具体那一份来拼参数。
      const isEsp8266Py = espota.isPy && espota.exe.includes('esp8266');
      const args = ['-i', ip, '-p', String(usePort), '-f', fw];
      if (pwd) args.push('-a', pwd);
      if (!isEsp8266Py) args.push('-t', '2', '-r');

      log(`目标: ${ip}:${usePort}${pwd ? '  (带密码)' : '  (无密码)'}`);
      log(`执行: ${espota.exe} ${args.join(' ')}`);

      const exe = espota.isPy ? findPython() : espota.exe;
      const fullArgs = espota.isPy ? [espota.exe, ...args] : args;

      let lastPct = -1;
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `OTA → ${ip}:${usePort}`, cancellable: false },
        (progress) =>
          new Promise<{ code: number; out: string }>((resolve) => {
            progress.report({ message: '连接中…' });
            const timer = setInterval(() => {
              // espota 每写入一段就刷新百分比
              if (lastPct >= 0) progress.report({ message: `${lastPct}%` });
            }, 500);
            const child = spawn(exe, fullArgs, { windowsHide: true });
            let out = '';
            const push = (b: Buffer) => {
              const s = b.toString();
              out += s;
              channel?.append(s.replace(/\r/g, '\n'));
              const pct = parsePercent(s);
              if (pct !== undefined && pct !== lastPct) {
                lastPct = pct;
                setStatus(`$(cloud-upload) OTA ${pct}%`, `正在上传到 ${ip}`);
              }
            };
            child.stdout?.on('data', push);
            child.stderr?.on('data', push);
            child.on('error', (e) => {
              clearInterval(timer);
              resolve({ code: -1, out: out + String(e) });
            });
            child.on('close', (code) => {
              clearInterval(timer);
              resolve({ code: code ?? -1, out });
            });
          })
      );
      return res;
    };


    let result = await doUpload(password, port);

    // 端口猜错：espota 会重试 10 次（约 100 秒）才报 No response。换另一个端口再试。
    if (result.code !== 0 && !detected && portCfg === 0 &&
        /No response|Sending invitation/i.test(result.out)) {
      const alt = otherPort(port);
      log(`端口 ${port} 无响应，改用 ${alt} 重试`);
      setStatus('$(sync~spin) OTA 换端口', `${port} 无响应，试 ${alt}`);
      const altResult = await doUpload(password, alt);
      if (altResult.code === 0) {
        await ctx.globalState.update(`espOta.port.${ip}`, alt);
        result = altResult;
        port = alt;
      }
    }

    // 认证失败 → 要密码后重试一次
    if (result.code !== 0 && isAuthFailure(result.out)) {
      log('认证失败，请求密码');
      setStatus('$(key) OTA 需要密码', '设备启用了密码');
      const pwd = await askPassword(ctx);
      if (pwd === undefined) {
        return;
      }
      password = pwd;
      result = await doUpload(pwd, port);
    }

    if (result.code === 0) {
      await ctx.globalState.update(`espOta.port.${ip}`, port);
    }

    log(`退出码: ${result.code}`);
    if (result.code !== 0) {
      log(`输出尾部: ${result.out.slice(-600)}`);
    }

    if (result.code === 0) {
      setStatus('$(check) OTA 完成', `已上传到 ${ip}`);
      vscode.window.showInformationMessage(`OTA 成功 → ${ip}`);
      setTimeout(() => setStatus('$(cloud-upload) OTA', '点击上传到 ESP 设备'), 5000);
    } else {
      setStatus('$(error) OTA 失败', `上传到 ${ip} 失败`);
      const hint = isAuthFailure(result.out)
        ? '密码不对'
        : /No response/i.test(result.out)
        ? '设备没响应（可能在忙，或 IP 不对）'
        : '详见日志文件';
      const pick = await vscode.window.showErrorMessage(`OTA 失败：${hint}`, '重试', '打开日志');
      if (pick === '重试') {
        busy = false;
        return upload(ctx);
      }
      if (pick === '打开日志') {
        const doc = await vscode.workspace.openTextDocument(LOG_FILE);
        await vscode.window.showTextDocument(doc);
      }
    }
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- 生命周期

export function activate(context: vscode.ExtensionContext) {
  channel = vscode.window.createOutputChannel('ESP OTA');

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'espOta.upload';
  statusItem.text = '$(cloud-upload) OTA';
  statusItem.tooltip = '点击：上传到手动指定的 IP（ESP32 / ESP8266）';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    channel,
    vscode.commands.registerCommand('espOta.upload', () => upload(context)),
    vscode.commands.registerCommand('espOta.setPassword', async () => {
      const p = await askPassword(context);
      if (p !== undefined) vscode.window.showInformationMessage(p ? 'OTA 密码已保存' : '已清除 OTA 密码');
    }),
    vscode.commands.registerCommand('espOta.setIp', async () => {
      const ip = await askIp(context);
      if (ip) vscode.window.showInformationMessage(`默认 OTA IP 已设为 ${ip}`);
    })
  );

  log('ESP OTA 扩展已加载');
}

export function deactivate() {
  statusItem?.dispose();
}
