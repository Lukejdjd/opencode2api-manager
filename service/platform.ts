import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
export async function command(file: string, args: string[], env?: Record<string,string>) {
  return (await exec(file, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } })).stdout.trim();
}
export async function ps(script: string, env: Record<string,string>) {
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference="Stop"; '+script, 'utf16le').toString('base64')], env);
}
export async function discoverMacBinary(plist: string) {
  const data = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
  return data.ProgramArguments?.[0] ?? data.Program;
}
export async function processMatches(pid: number, binary: string) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  if (process.platform === 'win32') {
    const found = await ps('$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:OC2_PID); if ($p -and $p.ExecutablePath -eq $env:OC2_BINARY) { "match" }', { OC2_PID: String(pid), OC2_BINARY: path.resolve(binary) });
    return found === 'match';
  }
  try { return (await command('/bin/ps', ['-p', String(pid), '-o', 'comm='])) === path.resolve(binary); } catch { return false; }
}
export async function control(action: 'start'|'stop'|'restart', s: { binary: string, configPath: string, launchLabel: string }, state: string, log: string) {
  if (process.platform === 'darwin' && s.launchLabel) {
    const label = `gui/${process.getuid!()}/${s.launchLabel}`;
    // bootout prevents KeepAlive from immediately bringing a stopped process back.
    const plist = path.join(process.env.HOME!, 'Library', 'LaunchAgents', `${s.launchLabel}.plist`);
    if (action !== 'start') {
      try { await command('/bin/launchctl', ['bootout', label]); }
      catch { if (action === 'stop') throw new Error('Cannot stop this LaunchAgent; check the configured label.'); }
    }
    if (action !== 'stop') {
      try { await command('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, plist]); }
      catch { await command('/bin/launchctl', ['kickstart', label]); }
    }
    return;
  }
  const pidPath = path.join(state, 'gateway-pid.json');
  let saved: any; try { saved = JSON.parse(await readFile(pidPath, 'utf8')); } catch {}
  const matching = saved?.binary === s.binary && await processMatches(saved.pid, s.binary);
  if (action !== 'start' && matching) {
    if (process.platform === 'win32') await ps('Stop-Process -Id ([int]$env:OC2_PID)', { OC2_PID: String(saved.pid) });
    else process.kill(saved.pid, 'SIGTERM');
    for (let i=0;i<30;i++) { if (!await processMatches(saved.pid,s.binary)) break; await new Promise(r=>setTimeout(r,200)); }
    if (await processMatches(saved.pid,s.binary)) throw new Error('Gateway is still shutting down; try again.');
  } else if (action === 'stop' && !matching) throw new Error('This gateway was not started by the manager. Stop it in its original service manager.');
  if (action !== 'stop' && !matching || action === 'restart' && matching) {
    // Do not stop or adopt an arbitrary existing process on Windows/Linux.
    const alive = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(1500) }).then(()=>true,()=>false);
    if (alive) throw new Error('Port 8080 is already in use. Stop the existing gateway first.');
    const fd = await open(log, 'a', 0o600);
    try {
      const child = spawn(s.binary, ['-config', s.configPath], { cwd: path.dirname(s.configPath), detached: true, windowsHide: true, stdio: ['ignore', fd.fd, fd.fd] });
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve); child.once('error',reject);});
      child.unref(); await writeFile(pidPath, JSON.stringify({pid:child.pid,binary:s.binary}), {mode:0o600});
    } finally { await fd.close(); }
  }
}
