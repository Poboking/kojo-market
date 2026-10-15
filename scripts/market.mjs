#!/usr/bin/env node
// kojo-market registry toolchain. Zero deps: node:crypto + node:zlib only.
// subcommands: validate | list | plan | zip | verify | manifest | index | hash

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { join, sep, dirname } from 'node:path';

const KINDS = ['kojo-pack', 'dict-pack', 'template-pack'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 12;
const MAX_NAME_BYTES = 512;
const SCHEMA = 1;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const nb = (s) => new TextEncoder().encode(s).length;

/* ---------------- path hygiene (posix, zip-slip proof) ---------------- */

/** @returns {string[]} 违规说明（空数组 = 合法） */
function pathViolations(p) {
  const e = [];
  if (typeof p !== 'string' || p.length === 0) return ['path 必须是非空字符串'];
  if (p.includes('\\')) e.push('path 必须是 posix 相对路径（不得含反斜杠）');
  if (/^[A-Za-z]:/.test(p)) e.push('path 不得带盘符');
  if (p.startsWith('/')) e.push('path 不得是绝对路径');
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) e.push('path 含空段/./.. 段');
  if (segs[0] !== 'files') e.push('path 必须以 files/ 开头');
  if (segs.length > MAX_DEPTH) e.push(`path 深度 ${segs.length} > ${MAX_DEPTH}`);
  if (nb(p) > MAX_NAME_BYTES) e.push(`path UTF-8 字节数 ${nb(p)} > ${MAX_NAME_BYTES}`);
  return e;
}

const isSymlink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/* ---------------- discovery: packs/<kind>/<id>/<version>/ ---------------- */

function discover(root) {
  const out = [], errors = [];
  let st;
  try { st = statSync(root); } catch { return { units: out, errors: [`${root}: packs 根目录不存在`] }; }
  if (!st.isDirectory()) return { units: out, errors: [`${root}: 不是目录`] };
  if (readdirSync(root).length === 0) return { units: out, errors: [`${root}: packs/ 为空，注册表至少需要一个包`] };
  for (const kind of readdirSync(root).sort()) {
    const kindDir = join(root, kind);
    if (!statSync(kindDir).isDirectory()) { errors.push(`${root}/${kind}: packs/ 下只允许 kind 目录`); continue; }
    if (!KINDS.includes(kind)) { errors.push(`${root}/${kind}: 未知 kind，允许 ${KINDS.join(' | ')}`); continue; }
    for (const id of readdirSync(kindDir).sort()) {
      const idDir = join(kindDir, id);
      if (!statSync(idDir).isDirectory()) { errors.push(`${kind}/${id}: 必须是包 id 目录`); continue; }
      if (!ID_RE.test(id)) errors.push(`${kind}/${id}: id 不匹配 ${ID_RE}`);
      for (const version of readdirSync(idDir).sort()) {
        const vDir = join(idDir, version);
        if (!statSync(vDir).isDirectory()) { errors.push(`${kind}/${id}/${version}: 必须是版本目录`); continue; }
        if (!VER_RE.test(version)) errors.push(`${kind}/${id}/${version}: version 不匹配 ${VER_RE}`);
        out.push({ kind, id, version, dir: vDir, rel: `${kind}/${id}/${version}` });
      }
    }
  }
  return { units: out.sort((a, b) => (a.rel < b.rel ? -1 : 1)), errors };
}

const cmpVer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/* ---------------- pack.json + disk closure ---------------- */

function readManifest(u, errs) {
  const mf = join(u.dir, 'pack.json');
  let text;
  try { text = readFileSync(mf); } catch { errs.push(`${u.rel}: 缺 pack.json`); return null; }
  if (isSymlink(mf)) errs.push(`${u.rel}/pack.json: 拒绝符号链接`);
  let j;
  try { j = JSON.parse(text.toString('utf8')); } catch (e) { errs.push(`${u.rel}/pack.json: JSON 解析失败 ${e.message}`); return null; }
  const E = (m) => errs.push(`${u.rel}/pack.json: ${m}`);
  if (j.schema !== SCHEMA) E(`schema 必须为 ${SCHEMA}（实际 ${JSON.stringify(j.schema)}）`);
  for (const k of ['kind', 'id', 'version', 'name', 'author', 'license', 'minAppVersion'])
    if (typeof j[k] !== 'string' || j[k].length === 0) E(`${k}: 必须是非空字符串`);
  if (j.kind !== u.kind) E(`kind=${JSON.stringify(j.kind)} 与所在目录 ${u.kind} 不一致`);
  if (j.id !== u.id) E(`id=${JSON.stringify(j.id)} 与所在目录 ${u.id} 不一致`);
  if (j.version !== u.version) E(`version=${JSON.stringify(j.version)} 与所在目录 ${u.version} 不一致`);
  if (j.redistribute !== true) E(`redistribute 必须为 true —— 原作者不许可时不得代理分发（当前 ${JSON.stringify(j.redistribute)}）`);
  if (typeof j.minAppVersion === 'string' && !VER_RE.test(j.minAppVersion)) E(`minAppVersion 必须匹配 ${VER_RE}`);
  for (const k of ['summary', 'sourceUrl', 'gameId'])
    if (j[k] !== undefined && (typeof j[k] !== 'string' || j[k].length === 0)) E(`${k}: 可选，给了就必须是非空字符串`);
  if (typeof j.sourceUrl === 'string' && !/^https:\/\/\S+$/.test(j.sourceUrl)) E('sourceUrl 必须是 https:// 绝对 URL');
  if (!Array.isArray(j.files)) E('files 必须是数组');
  const known = ['schema', 'kind', 'id', 'version', 'name', 'author', 'license', 'redistribute', 'sourceUrl', 'summary', 'minAppVersion', 'gameId', 'files'];
  for (const k of Object.keys(j)) if (!known.includes(k)) E(`未知字段 ${k}（契约外的键不许进 pack.json）`);
  return j;
}

function walkFiles(dir, errs, label, relPrefix = 'files') {
  const onDisk = new Map();
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const a = join(abs, name), r = `${rel}/${name}`;
      if (isSymlink(a)) { errs.push(`${label}: 拒绝符号链接 ${r}`); continue; }
      const st = lstatSync(a);
      if (st.isDirectory()) { walk(a, r); continue; }
      if (!st.isFile()) { errs.push(`${label}: 只允许普通文件 ${r}`); continue; }
      for (const v of pathViolations(r)) errs.push(`${label}: ${v}`);
      if (st.size > MAX_UNPACKED_BYTES) errs.push(`${label}: 单文件 ${r} ${st.size} > ${MAX_UNPACKED_BYTES}`);
      onDisk.set(r, { abs: a, bytes: st.size });
    }
  };
  const root = join(dir, relPrefix);
  try { if (!statSync(root).isDirectory()) throw new Error('not a dir'); }
  catch { errs.push(`${label}: 缺 files/ 目录`); return null; }
  walk(root, relPrefix);
  if (onDisk.size > MAX_ENTRIES) errs.push(`${label}: files/ 条目数 ${onDisk.size} > ${MAX_ENTRIES}`);
  return onDisk;
}

function scanUnit(u, errs) {
  const j = readManifest(u, errs);
  if (!j) return null;
  for (const e of readdirSync(u.dir).sort())
    if (e !== 'pack.json' && e !== 'files') errs.push(`${u.rel}: 版本目录根部只允许 pack.json 与 files/，发现 ${e}`);
  const onDisk = walkFiles(u.dir, errs, u.rel);
  if (!onDisk) return null;

  const declared = new Map();
  for (const f of j.files) {
    if (f === null || typeof f !== 'object') { errs.push(`${u.rel}: files 元素必须是对象`); continue; }
    for (const k of Object.keys(f)) if (!['path', 'bytes', 'sha256'].includes(k)) errs.push(`${u.rel}: files 元素含未知字段 ${k}`);
    const bad = pathViolations(f.path);
    if (bad.length) { for (const m of bad) errs.push(`${u.rel}: ${m}`); continue; }
    if (declared.has(f.path)) { errs.push(`${u.rel}: path 重复 ${f.path}`); continue; }
    if (!Number.isInteger(f.bytes) || f.bytes < 0) errs.push(`${u.rel}/${f.path}: bytes 必须是非负整数`);
    if (typeof f.sha256 !== 'string' || !HEX64_RE.test(f.sha256)) errs.push(`${u.rel}/${f.path}: sha256 必须是 64 位小写 hex`);
    declared.set(f.path, f);
  }
  for (const p of declared.keys()) if (!onDisk.has(p)) errs.push(`${u.rel}: manifest 声明但磁盘缺失 ${p}`);
  for (const p of onDisk.keys()) if (!declared.has(p)) errs.push(`${u.rel}: 磁盘存在但 manifest 未声明 ${p}（改内容必须写进 files[] 并 bump version）`);

  let unpacked = 0;
  for (const [p, f] of [...declared.entries()].sort()) {
    const d = onDisk.get(p);
    if (!d) continue;
    if (Number.isInteger(f.bytes) && d.bytes !== f.bytes) errs.push(`${u.rel}/${p}: bytes 声明 ${f.bytes} != 实际 ${d.bytes}`);
    const actual = sha256(readFileSync(d.abs));
    if (actual !== f.sha256) errs.push(`${u.rel}/${p}: sha256 重算不一致（防篡改闸）manifest ${f.sha256} / 实际 ${actual}`);
    unpacked += d.bytes;
  }
  if (unpacked > MAX_UNPACKED_BYTES) errs.push(`${u.rel}: 解压后 ${unpacked} > ${MAX_UNPACKED_BYTES}`);
  return {
    kind: j.kind, id: j.id, version: j.version, rel: u.rel, dir: u.dir, key: `${j.id}@${j.version}`,
    name: j.name, author: j.author, license: j.license, summary: j.summary,
    minAppVersion: j.minAppVersion, gameId: j.gameId, sourceUrl: j.sourceUrl,
    fileCount: declared.size, unpackedBytes: unpacked,
    files: [...declared.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, f]) => ({ path: p, bytes: f.bytes, sha256: f.sha256 })),
  };
}

function collect(root) {
  const { units, errors } = discover(root);
  const packs = [];
  const kindOfId = new Map();
  for (const u of units) {
    const m = scanUnit(u, errors);
    if (!m) continue;
    const prev = kindOfId.get(m.id);
    if (prev && prev !== m.kind) errors.push(`id "${m.id}" 同时出现在 ${prev} 与 ${m.kind}：tag <id>-v<version> 会碰撞，一个 id 只能属于一个 kind`);
    if (prev) kindOfId.set(m.id, prev); else kindOfId.set(m.id, m.kind);
    packs.push(m);
  }
  const seenVer = new Map();
  for (const m of packs) {
    const norm = `${m.id}#${m.version.split('.').map((s) => String(Number(s))).join('.')}`;
    const prev = seenVer.get(norm);
    if (prev && prev !== m.version)
      errors.push(`${m.id}: 版本 "${prev}" 与 "${m.version}" 数值相同（前导零歧义）——「同 id 取最高版本」无法确定，请写规范形`);
    seenVer.set(norm, m.version);
  }
  packs.sort((a, b) => a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id !== b.id ? (a.id < b.id ? -1 : 1) : cmpVer(a.version, b.version));
  return { packs, errors };
}

const resolve = (packs, sel) =>
  packs.find((p) => p.rel === sel || p.dir === sel || `${p.id}@${p.version}` === sel || `${p.kind}/${p.id}/${p.version}` === sel || sel.endsWith(p.rel));

/* ---------------- zip: deterministic, no dir entries, no extra fields ---------------- */

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const FLAG_UTF8 = 0x0800, V20 = 20, DOS_TIME = 0, DOS_DATE = 0x21; // 钉死 1980-01-01，不看 mtime
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;

function buildZip(entries) {
  const pre = entries.map((e) => {
    const nameBytes = Buffer.from(e.name, 'utf8');
    let method = 0, payload = e.data;
    if (e.data.length > 0) {
      const z = deflateRawSync(e.data, { level: 9 });
      if (z.length < e.data.length) { method = 8; payload = z; }
    }
    return { nameBytes, method, payload, crc: crc32(e.data), size: e.data.length };
  });
  let total = 0, central = 0;
  for (const p of pre) { total += 30 + p.nameBytes.length + p.payload.length; central += 46 + p.nameBytes.length; }
  if (pre.length > 0xffff) throw new Error(`条目 ${pre.length} 超 ZIP64 门槛`);
  const out = Buffer.alloc(total + central + 22);
  let off = 0;
  const u16 = (v) => { out.writeUInt16LE(v >>> 0, off); off += 2; };
  const u32 = (v) => { out.writeUInt32LE(v >>> 0, off); off += 4; };
  const put = (b, n) => { out.set(b, off); off += n; };
  const offsets = [];
  for (const p of pre) {
    offsets.push(off);
    u32(SIG_LOCAL); u16(V20); u16(FLAG_UTF8); u16(p.method); u16(DOS_TIME); u16(DOS_DATE);
    u32(p.crc); u32(p.payload.length); u32(p.size); u16(p.nameBytes.length); u16(0);
    put(p.nameBytes, p.nameBytes.length); put(p.payload, p.payload.length);
  }
  const cStart = off;
  pre.forEach((p, i) => {
    u32(SIG_CENTRAL); u16(V20); u16(V20); u16(FLAG_UTF8); u16(p.method); u16(DOS_TIME); u16(DOS_DATE);
    u32(p.crc); u32(p.payload.length); u32(p.size); u16(p.nameBytes.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i]);
    put(p.nameBytes, p.nameBytes.length);
  });
  const cEnd = off;
  u32(SIG_EOCD); u16(0); u16(0); u16(pre.length); u16(pre.length);
  u32(cEnd - cStart); u32(cStart); u16(0);
  return out;
}

function readZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('EOCD 未找到：不是合法 ZIP 或被截断');
  const count = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 8) !== count) throw new Error('不支持多磁盘 ZIP');
  if (buf.readUInt16LE(eocd + 20) !== 0) throw new Error('ZIP 带注释，拒绝');
  if (count > MAX_ENTRIES) throw new Error(`ZIP 条目 ${count} > ${MAX_ENTRIES}`);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`中央目录第 ${n} 条签名不符`);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if ((flags & FLAG_UTF8) === 0) throw new Error(`${name}: 未置 UTF-8 标志位`);
    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error(`${name}: 本地头签名不符`);
    const dstart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const comp = buf.subarray(dstart, dstart + csize);
    const data = method === 8 ? inflateRawSync(comp) : method === 0 ? Buffer.from(comp) : (() => { throw new Error(`${name}: 不支持的压缩方法 ${method}`); })();
    if (data.length !== usize) throw new Error(`${name}: 解压后长度 ${data.length} != 声明 ${usize}`);
    if ((crc32(data) >>> 0) !== (crc >>> 0)) throw new Error(`${name}: CRC 不符`);
    entries.push({ name, data });
  }
  return entries;
}

const packEntries = (m) => [
  { name: 'pack.json', data: readFileSync(join(m.dir, 'pack.json')) },
  ...m.files.map((f) => ({ name: f.path, data: readFileSync(join(m.dir, ...f.path.split('/'))) })),
];

const MANIFEST_KEYS = ['schema', 'kind', 'id', 'version', 'name', 'author', 'license', 'redistribute', 'sourceUrl', 'summary', 'minAppVersion', 'gameId', 'files'];
const manifestJson = (meta, files) => {
  const o = {};
  for (const k of MANIFEST_KEYS) {
    if (k === 'files') o.files = files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }));
    else if (meta[k] !== undefined) o[k] = meta[k];
  }
  return o;
};

/** 读目录 + 重算逐文件 sha256 -> 权威 pack.json 对象（作者上架只手写元数据，散列交给这个） */
function stampUnit(root, sel) {
  const segs = sel.split('/');
  if (segs.length !== 3) fail([`stamp/manifest: 需要 <kind/id/version>，收到 ${sel}`]);
  const u = { kind: segs[0], id: segs[1], version: segs[2], dir: join(root, ...segs), rel: sel };
  const errs = [];
  if (!statSync(u.dir).isDirectory()) fail([`${sel}: 目录不存在`]);
  const j = readManifest(u, errs);
  if (!j) fail(errs);
  for (const e of readdirSync(u.dir).sort())
    if (e !== 'pack.json' && e !== 'files') errs.push(`${sel}: 版本目录根部只允许 pack.json 与 files/，发现 ${e}`);
  const onDisk = walkFiles(u.dir, errs, sel);
  if (!onDisk) fail(errs);
  let unpacked = 0;
  const files = [...onDisk.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, d]) => {
    unpacked += d.bytes;
    return { path: p, bytes: d.bytes, sha256: sha256(readFileSync(d.abs)) };
  });
  if (unpacked > MAX_UNPACKED_BYTES) errs.push(`${sel}: 解压后 ${unpacked} > ${MAX_UNPACKED_BYTES}`);
  if (errs.length) fail(errs);
  return { json: manifestJson(j, files), files, unpacked, u };
}

function fail(errors) { for (const e of errors) console.error(`FAIL ${e}`); process.exit(1); }
const writeFile = (p, data) => { const d = dirname(p); if (d && d !== p) mkdirSync(d, { recursive: true }); writeFileSync(p, data); };

/* ---------------- commands ---------------- */

const [cmd, ...args] = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));

if (cmd === 'hash') {
  const b = readFileSync(positional[0]);
  process.stdout.write(`${sha256(b)}\t${b.length}\n`);
} else if (cmd === 'validate' || cmd === 'list') {
  const { packs, errors } = collect(positional[0] ?? 'packs');
  for (const m of packs) console.log(`${cmd === 'list' ? 'pack' : 'ok'} ${m.rel} files=${m.fileCount} unpacked=${m.unpackedBytes}`);
  if (errors.length) fail(errors);
  console.log(`validate: ${packs.length} 个包版本全部通过（sha256 已逐文件重算比对）`);
} else if (cmd === 'plan') {
  const { packs, errors } = collect(positional[0] ?? 'packs');
  if (errors.length) fail(errors);
  for (const m of packs) process.stdout.write(`${m.kind}\t${m.id}\t${m.version}\t${m.rel}\t${m.id}-v${m.version}\t${m.id}-${m.version}.zip\n`);
} else if (cmd === 'zip') {
  const { packs, errors } = collect(positional[0]);
  if (errors.length) fail(errors);
  const m = resolve(packs, positional[1]);
  if (!m) fail([`zip: 索引中没有 ${positional[1]}`]);
  const zip = buildZip(packEntries(m));
  if (zip.length > MAX_ZIP_BYTES) fail([`zip: ${zip.length} > ${MAX_ZIP_BYTES}`]);
  writeFile(positional[2], zip);
  process.stdout.write(`${zip.length}\t${sha256(zip)}\n`);
} else if (cmd === 'verify') {
  const { packs, errors } = collect(positional[0]);
  if (errors.length) fail(errors);
  const m = resolve(packs, positional[1]);
  if (!m) fail([`verify: 索引中没有 ${positional[1]}`]);
  const errs = [];
  const zip = readFileSync(positional[2]);
  if (zip.length > MAX_ZIP_BYTES) errs.push(`zip ${zip.length} > ${MAX_ZIP_BYTES}`);
  let entries = null;
  try { entries = readZip(zip); } catch (e) { errs.push(`zip 解析失败：${e.message}`); }
  if (entries) {
    const expect = ['pack.json', ...m.files.map((f) => f.path)].sort();
    const got = entries.map((e) => e.name).sort();
    if (expect.length > MAX_ENTRIES) errs.push(`条目 ${expect.length} > ${MAX_ENTRIES}`);
    if (JSON.stringify(expect) !== JSON.stringify(got)) errs.push(`zip 根部条目集不符：期望 pack.json + files/** 共 ${expect.length} 项，实际 ${got.length} 项 [${got.join(', ')}]`);
    let unpacked = 0;
    for (const e of entries) {
      const bad = e.name === 'pack.json' ? [] : pathViolations(e.name);
      for (const v of bad) errs.push(`zip 条目 ${v}`);
      if (e.name === 'pack.json') {
        if (!readFileSync(join(m.dir, 'pack.json')).equals(e.data)) errs.push('zip 内 pack.json 与仓库 pack.json 不一致：已发布版本不许改内容，请 bump version');
      } else {
        const f = m.files.find((x) => x.path === e.name);
        if (f) {
          const h = sha256(e.data);
          if (h !== f.sha256) errs.push(`zip/${e.name}: 内容 sha256 ${h} != manifest ${f.sha256}`);
          unpacked += e.data.length;
        }
      }
    }
    if (unpacked > MAX_UNPACKED_BYTES) errs.push(`zip 解压后 ${unpacked} > ${MAX_UNPACKED_BYTES}`);
  }
  if (errs.length) fail(errs);
  console.error(`verify: ${positional[2]} 与 ${m.rel} 一致（${entries.length} 条目）`);
  process.stdout.write(`${zip.length}\t${sha256(zip)}\n`);
} else if (cmd === 'manifest' || cmd === 'stamp') {
  const root = positional[0] ?? 'packs';
  const { json, files, unpacked } = stampUnit(root, positional[1]);
  const text = JSON.stringify(json, null, 2) + '\n';
  if (cmd === 'stamp') {
    writeFile(join(root, ...positional[1].split('/'), 'pack.json'), text);
    console.error(`stamp: ${files.length} 文件 / ${unpacked} 字节，sha256 已重算写入 pack.json`);
  } else process.stdout.write(text);
} else if (cmd === 'index') {
  const root = positional[0] ?? 'packs';
  const factsPath = positional[1] ?? 'dist/facts.jsonl';
  const out = positional[2] ?? 'dist/index.json';
  const commitDate = flag('commit-date', null);
  if (!commitDate) fail(['index: --commit-date <iso> 必填（generatedAt 钉在 commit 上，同 commit 重跑才逐字节相同）']);
  const { packs, errors } = collect(root);
  if (errors.length) fail(errors);
  const facts = new Map();
  for (const line of readFileSync(factsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    const e = [];
    if (typeof f.url !== 'string' || !/^https:\/\/\S+$/.test(f.url)) e.push(`url 非法 ${JSON.stringify(f.url)}`);
    if (typeof f.sha256 !== 'string' || !HEX64_RE.test(f.sha256)) e.push(`sha256 非法 ${f.id}@${f.version}`);
    if (!Number.isInteger(f.bytes) || f.bytes <= 0 || f.bytes > MAX_ZIP_BYTES) e.push(`bytes 非法 ${f.id}@${f.version}`);
    if (e.length) fail(e.map((x) => `fact ${x}`));
    facts.set(`${f.id}@${f.version}`, f);
  }
  const latest = new Map();
  for (const m of packs) {
    const cur = latest.get(m.id);
    if (!cur || cmpVer(m.version, cur.version) > 0) latest.set(m.id, m);
  }
  const rows = [], missing = [];
  for (const m of [...latest.values()].sort((a, b) => a.id < b.id ? -1 : 1)) {
    const f = facts.get(m.key);
    if (!f) { missing.push(m.rel); continue; }
    const row = { kind: m.kind, id: m.id, version: m.version, name: m.name, author: m.author, license: m.license };
    if (m.summary !== undefined) row.summary = m.summary;
    row.minAppVersion = m.minAppVersion;
    if (m.gameId !== undefined) row.gameId = m.gameId;
    if (m.sourceUrl !== undefined) row.sourceUrl = m.sourceUrl;
    row.zip = { url: f.url, sha256: f.sha256, bytes: f.bytes };
    row.fileCount = m.fileCount;
    row.unpackedBytes = m.unpackedBytes;
    rows.push(row);
  }
  if (missing.length) fail([`下列已声明包版本没有 zip 资产事实（未发布/发布失败）:\n  ${missing.join('\n  ')}`]);
  rows.sort((a, b) => a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : (a.id < b.id ? -1 : 1));
  const doc = { schema: SCHEMA, generatedAt: new Date(commitDate).toISOString(), packs: rows };
  writeFile(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`index: ${rows.length} 条（同 id 取最高版本）-> ${out}`);
} else {
  console.error(`用法: market.mjs <cmd> [args]
  validate [packs]
  list     [packs]                                 TSV 概要
  plan     [packs]   -> TSV: kind id version rel tag assetName
  zip      <packs> <kind/id/version|id@version> <out.zip>      -> bytes\\tsha256
  verify   <packs> <kind/id/version> <zip>         已发布资产一致性闸 -> bytes\\tsha256
  manifest <packs> <kind/id/version>               重算 sha256 后打到 stdout
  stamp    <packs> <kind/id/version>               同上，但写回 pack.json
  index    [packs] [facts.jsonl] [out.json] --commit-date <iso>
  hash     <file>`);
  process.exit(2);
}
