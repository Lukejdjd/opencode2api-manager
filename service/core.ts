import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser/lib/esm/main.js';
export const REPO = 'jasonxu114514/opencode2api';
export function parseConfig(text: string): any {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Configuration is not a valid JSON object.');
  return data;
}
export function edit(text: string, path: (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
export function newer(latest: string, current: string) {
  const version = (s: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s)?.slice(1).map(Number);
  const a = version(latest), b = version(current);
  return !!a && !!b && a.some((v, i) => v > b[i]! && a.slice(0, i).every((x, j) => x === b[j]));
}
export function assetName(platform: string, arch: string, tag: string) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Only stable version tags are supported.');
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported platform/architecture.');
  if (platform === 'win32' && arch !== 'x64') throw new Error('Windows ARM64 requires an x64 Node runtime (upstream publishes Windows x64).');
  return `opencode2api_${tag}_${platform === 'win32' ? 'windows' : platform}_${arch === 'x64' ? 'amd64' : 'arm64'}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}
export function mergeCatalog(text: string, rows: any[]) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error('Empty or invalid catalog; existing models preserved.');
  const c = parseConfig(text);
  const key = c.providers?.opencode2api ? 'providers' : c.provider?.opencode2api ? 'provider' : null;
  if (!key) throw new Error('Add an opencode2api provider in OpenCode/OpenChamber first.');
  const p = c[key].opencode2api;
  const url = p.settings?.baseURL ?? p.options?.baseURL;
  if (url?.replace(/\/$/, '') !== 'http://127.0.0.1:8080/v1') throw new Error('Only the local opencode2api provider at port 8080 is supported.');
  let result = text; const added: string[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) throw new Error('Invalid model entry; no changes saved.');
    const id = row.id, prior = p.models?.[id];
    if (prior && (prior.modelID ?? prior.id ?? id) !== id) continue;
    const m = structuredClone(prior ?? (key === 'providers' ? { modelID: id, name: id } : { name: id }));
    if (!prior) added.push(id);
    for (const [source, dest] of [['context_window', 'context'], ['max_input', 'input'], ['max_output', 'output']]) {
      const n = row[source!] ?? row.metadata?.[source!];
      if (Number.isSafeInteger(n) && n > 0) (m.limit ??= {})[dest!] = n;
    }
    const meta = row.metadata ?? {};
    if (key === 'providers') {
      if (typeof meta.tool_call === 'boolean') (m.capabilities ??= {}).tools = meta.tool_call;
      for (const [source, dest] of [['input_modalities', 'input'], ['output_modalities', 'output']]) {
        const values = meta[source!];
        if (Array.isArray(values) && values.length && values.every(x => typeof x === 'string')) (m.capabilities ??= {})[dest!] = values;
      }
    } else {
      if (typeof meta.tool_call === 'boolean') m.tool_call = meta.tool_call;
      for (const [source, dest] of [['input_modalities', 'input'], ['output_modalities', 'output']]) {
        const values = meta[source!];
        if (Array.isArray(values) && values.length && values.every(x => typeof x === 'string')) (m.modalities ??= {})[dest!] = values;
      }
    }
    // Edit individual fields to retain comments on custom fields and names.
    for (const [field, value] of Object.entries(m)) {
      if (JSON.stringify(prior?.[field]) !== JSON.stringify(value)) result = edit(result, [key, 'opencode2api', 'models', id, field], value);
    }
  }
  return { text: result, added, count: Object.keys(parseConfig(result)[key].opencode2api.models).length };
}
export function validateArchiveEntries(entries: string[]) {
  for (const name of entries) {
    if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Unsafe archive path.');
  }
}
