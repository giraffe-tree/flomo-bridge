/**
 * Flomo Memo 格式转换器
 *
 * 将 flomo memo 转换为 Markdown 格式（含 frontmatter + 正文）
 */

import { FlomoMemo, FlomoFile } from './types';

/** 支持的图片格式 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** 支持的音频格式 */
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.wav', '.ogg']);

/**
 * 将 HTML 内容转换为 Markdown
 *
 * flomo 的 content 是 HTML 格式，需要转换为 Markdown
 *
 * @param html - HTML 字符串
 * @returns Markdown 字符串
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';

  // 使用简单的 HTML 到 Markdown 转换
  // 注意：Obsidian 环境不能使用 Node.js 的库，所以手动实现
  let md = html;

  // 1. 处理代码块
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => {
    const cleanCode = code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    return '\n```\n' + cleanCode + '\n```\n';
  });

  // 2. 处理内联代码
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // 3. 处理粗体
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**');

  // 4. 处理斜体
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*');

  // 5. 处理删除线
  md = md.replace(/<del[^>]*>(.*?)<\/del>/gi, '~~$1~~');

  // 6. 处理链接
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // 7. 处理图片
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]+alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)');
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

  // 8. 处理标题
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n###### $1\n');

  // 9. 处理无序列表
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '\n$1\n');

  // 10. 处理有序列表
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '\n$1\n');

  // 11. 处理段落
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');

  // 12. 处理换行
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 13. 处理 div
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

  // 14. 移除其他标签
  md = md.replace(/<[^>]+>/g, '');

  // 15. HTML 实体解码
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');

  // 16. 清理多余空白
  md = md
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

/**
 * 从 URL 提取文件扩展名
 *
 * @param url - 文件 URL
 * @returns 小写扩展名（带 .）
 */
export function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase();
    return ext.includes('.') ? ext : '';
  } catch {
    return '';
  }
}

/**
 * 生成附件的 Markdown 链接
 *
 * @param file - 附件信息
 * @param localPath - 本地路径（如果已下载）
 * @returns Markdown 链接字符串
 */
export function formatAttachment(file: FlomoFile, localPath?: string): string {
  const name = file.name || 'file';
  const url = localPath || file.url || '';

  if (!url) {
    return `- ${name}`;
  }

  // 优先使用 file.url 判断类型，因为 URL 包含扩展名，而本地路径可能没有
  const ext = getExtensionFromUrl(file.url) || getExtensionFromUrl(file.name);

  // 图片使用 ![]() 嵌入
  if (IMAGE_EXTS.has(ext)) {
    return `![${name}](${url})`;
  }

  // 音频文件添加 [音频] 标识
  if (AUDIO_EXTS.has(ext)) {
    return `[音频: ${name}](${url})`;
  }

  // 其他文件使用 []() 链接
  return `[${name}](${url})`;
}

/**
 * 生成 memo 的 Markdown 文本
 *
 * @param memo - flomo memo
 * @param attachmentPaths - 附件本地路径映射（key: url, value: 相对路径）
 * @returns 完整的 Markdown 内容
 */
export function memoToMarkdown(
  memo: FlomoMemo,
  attachmentPaths?: Map<string, string>
): string {
  // 1. 构建 frontmatter
  const tags = memo.tags || [];
  const tagsStr = tags.length > 0 ? JSON.stringify(tags) : '[]';

  // 添加调试日志
  console.debug('[FlomoSync Debug] memoToMarkdown - tags input:', tags);
  console.debug('[FlomoSync Debug] memoToMarkdown - tagsStr output:', tagsStr);
  console.debug('[FlomoSync Debug] memoToMarkdown - attachmentPaths:', attachmentPaths ? Object.fromEntries(attachmentPaths) : null);

  // 2. 转换正文
  let body = htmlToMarkdown(memo.content || '');

  // 3. 处理附件
  let attachmentsSection = '';
  const files = memo.files || [];
  if (files.length > 0) {
    const fileLines = files.map((f) => {
      const localPath = attachmentPaths?.get(f.url);
      console.debug('[FlomoSync Debug] Processing attachment - file:', f.name, 'url:', f.url, 'localPath:', localPath);
      return formatAttachment(f, localPath);
    });
    attachmentsSection = '\n\n**附件:**\n' + fileLines.join('\n');
  }

  // 4. 组装最终内容
  const result = `---
slug: ${memo.slug}
created_at: "${memo.created_at || ''}"
updated_at: "${memo.updated_at || ''}"
tags: ${tagsStr}
source: "${memo.source || ''}"
---

${body}${attachmentsSection}
`;

  console.debug('[FlomoSync Debug] memoToMarkdown - final result length:', result.length);
  return result;
}

/**
 * 生成 memo 的文件名
 *
 * 格式：{日期}_{标签叶}_{内容前6字}_{slug}.md
 *
 * @param memo - flomo memo
 * @returns 文件名（不含路径）
 */
export function generateFilename(memo: FlomoMemo): string {
  const slug = memo.slug || `memo_${Date.now()}`;
  const parts: string[] = [];

  // 1. 日期（从 created_at 提取）
  const createdAt = memo.created_at || '';
  if (createdAt.length >= 10) {
    parts.push(createdAt.slice(0, 10)); // YYYY-MM-DD
  }

  // 2. 第一个标签的叶子部分
  const tags = memo.tags || [];
  if (tags.length > 0) {
    const firstTag = tags[0];
    const leaf = firstTag.split('/').pop() || firstTag;
    // 移除文件系统不允许的字符
    const safeLeaf = leaf.replace(/[\\/:*?"<>|]/g, '').trim();
    if (safeLeaf) {
      parts.push(safeLeaf);
    }
  }

  // 3. 内容前 6 个有效字符（汉字 + 字母数字）
  const contentMd = htmlToMarkdown(memo.content || '');
  // 移除 #标签
  const contentClean = contentMd.replace(/#\S+/g, '');
  // 只保留汉字和字母数字
  const chars = contentClean.match(/[\u4e00-\u9fa5\w]/g) || [];
  const preview = chars.slice(0, 6).join('');
  if (preview) {
    parts.push(preview);
  }

  // 4. slug
  parts.push(slug);

  return parts.join('_') + '.md';
}

/**
 * 从 filename 中提取 slug
 *
 * @param filename - 文件名
 * @returns slug 或 null
 */
export function extractSlugFromFilename(filename: string): string | null {
  // 匹配 _{slug}.md 格式
  const match = filename.match(/_([A-Za-z0-9]+)\.md$/);
  return match ? match[1] : null;
}

/**
 * 解析时间戳
 *
 * flomo 的时间格式可能是字符串 "2024-07-11 00:20:04" 或时间戳
 *
 * @param time - 时间字符串或数字
 * @returns Unix 时间戳（秒）
 */
export function parseTimestamp(time: string | number): number {
  if (typeof time === 'number') {
    // 可能是毫秒或秒
    return time > 9999999999 ? Math.floor(time / 1000) : time;
  }

  if (typeof time === 'string') {
    // 尝试解析日期字符串
    const date = new Date(time.replace(' ', 'T'));
    if (!isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1000);
    }
  }

  return 0;
}

/**
 * 判断文件是否为图片
 *
 * @param filename - 文件名或URL
 * @returns 是否为图片
 */
export function isImage(filename: string): boolean {
  // 移除URL查询参数
  const cleanName = filename.split('?')[0];
  const ext = cleanName.slice(cleanName.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/**
 * 判断文件是否为音频
 *
 * @param filename - 文件名或URL
 * @returns 是否为音频
 */
export function isAudio(filename: string): boolean {
  // 移除URL查询参数
  const cleanName = filename.split('?')[0];
  const ext = cleanName.slice(cleanName.lastIndexOf('.')).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/**
 * 从 URL 提取图片标识作为文件名
 *
 * 提取 URL 路径中最后一个 `/` 和 `.` 之间的部分作为图片标识
 * 例如: https://flomo-resource.oss-cn-beijing.aliyuncs.com/abc/123/image_xxx.jpg
 *       -> image_xxx.jpg
 *
 * @param url - 图片 URL
 * @returns 提取的文件名（含扩展名），如果提取失败则返回 null
 */
export function extractImageIdFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    // 取最后一段路径（文件名部分）
    const filename = pathname.split('/').pop() || '';
    // 确保文件名有扩展名
    if (filename.includes('.')) {
      return filename;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 JPEG 图片的 EXIF 元数据中解析拍摄时间 (DateTimeOriginal)
 *
 * @param buffer - 图片文件的 ArrayBuffer
 * @returns 拍摄时间 Date 对象，如果解析失败则返回 null
 */
export function extractExifDateTime(buffer: ArrayBuffer): Date | null {
  const view = new DataView(buffer);
  const length = buffer.byteLength;

  // 检查 JPEG SOI marker
  if (view.getUint16(0, false) !== 0xFFD8) return null;

  let offset = 2;
  while (offset < length) {
    const marker = view.getUint16(offset, false);
    if (marker === 0xFFD9) break; // EOI

    const fieldLength = view.getUint16(offset + 2, false);

    // APP1 marker (EXIF)
    if (marker === 0xFFE1) {
      const exifOffset = offset + 4;
      // 检查 EXIF 头
      const headerBytes = new Uint8Array(buffer, exifOffset, 6);
      const header = String.fromCharCode(...headerBytes);
      if (header === 'Exif\x00\x00') {
        const tiffOffset = exifOffset + 6;
        const littleEndian = view.getUint16(tiffOffset, false) === 0x4949;

        // IFD0 offset
        const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian);
        let ifdPos = tiffOffset + ifdOffset;

        const numEntries = view.getUint16(ifdPos, littleEndian);
        ifdPos += 2;

        for (let i = 0; i < numEntries; i++) {
          const tag = view.getUint16(ifdPos, littleEndian);
          if (tag === 0x9003) { // DateTimeOriginal
            const type = view.getUint16(ifdPos + 2, littleEndian);
            const count = view.getUint32(ifdPos + 4, littleEndian);
            const valueOffset = view.getUint32(ifdPos + 8, littleEndian);

            if (type === 2) { // ASCII
              const strOffset = count > 4 ? tiffOffset + valueOffset : ifdPos + 8;
              const bytes = new Uint8Array(buffer, strOffset, 19);
              const dateStr = String.fromCharCode(...bytes);
              // 格式: "2024:01:15 10:30:00"
              const match = dateStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
              if (match) {
                const [, year, month, day, hour, min, sec] = match;
                return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
              }
            }
          }
          ifdPos += 12;
        }
      }
    }
    offset += 2 + fieldLength;
  }
  return null;
}
