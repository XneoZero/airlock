import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { digestFiles, buildManifest, packProject, unpackArchive } from '../src/deploy/archive.ts';

/** 手工拼一个 ustar 头：tar 库不接受任意 name 写入，构造恶意包只能自己动手。 */
function tarHeader(name, size) {
  const buffer = Buffer.alloc(512);
  buffer.write(name, 0, 100, 'utf8');
  buffer.write('0000644\0', 100, 8);
  buffer.write('0000000\0', 108, 8);
  buffer.write('0000000\0', 116, 8);
  buffer.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  buffer.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  buffer.write('        ', 148, 8);
  buffer.write('0', 156, 1);
  buffer.write('ustar\0', 257, 6);
  buffer.write('00', 263, 2);
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return buffer;
}

function makeTar(entries) {
  const parts = [];
  for (const { name, content } of entries) {
    const data = Buffer.from(content, 'utf8');
    parts.push(tarHeader(name, data.length), data);
    parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'airlock-archive-'));
}

test('打包再解包：内容与摘要完全一致', async () => {
  const source = await tempDir();
  const target = await tempDir();
  try {
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'package.json'), '{"name":"demo"}\n');
    await writeFile(join(source, 'src', 'a.js'), 'export const a = 1;\n');
    await writeFile(join(source, 'README.md'), '# demo\n');

    const archive = join(source, 'out.tar.gz');
    const packed = await packProject({ sourceDir: source, outFile: archive });
    assert.equal(packed.files.length, 3);
    assert.match(packed.totalHash, /^[a-f0-9]{64}$/);

    const unpacked = await unpackArchive({ archive, destDir: target });
    assert.equal(unpacked.totalHash, packed.totalHash);
    assert.equal(await readFile(join(target, 'src', 'a.js'), 'utf8'), 'export const a = 1;\n');
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('默认排除版本库与依赖目录', async () => {
  const source = await tempDir();
  try {
    await mkdir(join(source, 'node_modules', 'zod'), { recursive: true });
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, 'node_modules', 'zod', 'index.js'), 'x');
    await writeFile(join(source, '.git', 'HEAD'), 'ref');
    await writeFile(join(source, 'app.js'), 'ok');
    const manifest = await buildManifest(source);
    assert.deepEqual(manifest.files.map(file => file.path), ['app.js']);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test('全树摘要与文件顺序无关', () => {
  const a = { path: 'a.txt', size: 1, hash: 'a'.repeat(64) };
  const b = { path: 'b.txt', size: 2, hash: 'b'.repeat(64) };
  assert.equal(digestFiles([a, b]), digestFiles([b, a]));
});

test('拒绝带路径穿越的归档', async () => {
  const root = await tempDir();
  const target = await tempDir();
  try {
    const archive = join(root, 'evil.tar.gz');
    await writeFile(archive, gzipSync(makeTar([{ name: '../escape.txt', content: 'pwned' }])));
    await assert.rejects(() => unpackArchive({ archive, destDir: target }), /上跳|绝对路径/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('展开超过上限时拒绝', async () => {
  const source = await tempDir();
  const target = await tempDir();
  try {
    await writeFile(join(source, 'big.txt'), 'x'.repeat(4096));
    const archive = join(source, 'out.tar.gz');
    await packProject({ sourceDir: source, outFile: archive });
    await assert.rejects(() => unpackArchive({ archive, destDir: target, maxBytes: 100 }), /超过/);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
