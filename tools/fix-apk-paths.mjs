/**
 * 修正 APK 内 assets 条目名的路径分隔符。
 *
 * 问题：aapt2 在 Windows 上给 `-A <目录>` 里的文件建条目时用的是平台分隔符，
 * 于是产物里是 `assets/js\app.js`。而 Android 资源表要求正斜杠，
 * AssetManager.open("js/app.js") 会直接找不到 —— 应用表现为白屏。
 *
 * 做法：只改文件名，不动数据。
 *   `\` 与 `/` 都是单字节，替换前后长度不变 ⇒ 条目名长度、后续条目偏移、
 *   以及 CRC（zip 的 CRC 只覆盖文件内容，不含文件名）全部保持不变。
 *   所以可以纯粹按字节改写，不必解压重压 —— 这点很关键，因为
 *   resources.arsc 必须保持 STORED（未压缩）且 4 字节对齐，
 *   任何"重新打包"都会破坏它，导致 Android 11+ 上安装直接被拒。
 *
 * 只在中央目录与对应的本地文件头里改文件名，其余字节原样保留。
 *
 *   node tools/fix-apk-paths.mjs <apk>
 *
 * 由 tools/build-apk.ps1 在 aapt2 link 之后、javac 之前调用（见其第 [3.5] 步）。
 * 单独调用时默认处理 dist-apk/deepseek-chat.apk。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const buf = readFileSync(process.argv[2] || 'dist-apk/deepseek-chat.apk');

/** 从尾部倒着找 EOCD（注释长度可变，所以不能直接定位到 len-22）。 */
function findEocd(b) {
  const max = Math.min(b.length, 0xffff + 22);
  for (let i = b.length - 22; i >= b.length - max; i--) {
    if (i < 0) break;
    if (b.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('找不到 EOCD，不是有效的 zip/apk');
}

const eocd = findEocd(buf);
const count = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);      // 中央目录起始偏移

const patches = [];   // { offset, oldName, newName }

for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`中央目录第 ${i} 项签名异常`);

  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);

  const nameStart = p + 46;
  const oldName = buf.toString('utf8', nameStart, nameStart + nameLen);
  const newName = oldName.replace(/\\/g, '/');

  if (newName !== oldName) {
    if (newName.length !== oldName.length) {
      throw new Error(`条目名长度会变化，无法就地改写：${oldName}`);
    }
    // 本地文件头：签名(4) + 版本(2) + 标志(2) + 压缩(2) + 时间(2) + 日期(2)
    //           + CRC(4) + 压缩大小(4) + 原始大小(4) + 名长(2) = 30
    if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`本地文件头签名异常：${oldName}`);
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    if (locNameLen !== nameLen) {
      throw new Error(`本地头与中央目录名长不一致：${oldName} (${locNameLen} vs ${nameLen})`);
    }
    patches.push({ cen: nameStart, loc: localOffset + 30, oldName, newName });
  }

  p = nameStart + nameLen + extraLen + commentLen;
}

if (!patches.length) {
  console.log('无需修正：没有条目使用反斜杠。');
  process.exit(0);
}

for (const { cen, loc, oldName, newName } of patches) {
  const bytes = Buffer.from(newName, 'utf8');
  if (bytes.length !== Buffer.byteLength(oldName, 'utf8')) {
    throw new Error(`编码后长度不一致：${oldName}`);
  }
  bytes.copy(buf, cen);
  bytes.copy(buf, loc);
}

writeFileSync(process.argv[2] || 'dist-apk/deepseek-chat.apk', buf);

const sample = patches.slice(0, 3).map((x) => `${x.oldName} → ${x.newName}`);
console.log(`已修正 ${patches.length} 个条目名（数据与压缩方式未变）`);
for (const s of sample) console.log('  ' + s);
if (patches.length > sample.length) console.log(`  … 另有 ${patches.length - sample.length} 个`);
