/**
 * 反向链接替换器
 *
 * 将 flomo memo URL 替换为 Obsidian 内部链接
 */

import { BacklinkIndex } from './backlinkIndex';

/** 链接格式 */
export type BacklinkLinkStyle = 'wikilink' | 'markdown';

/** Markdown 格式的 flomo memo 链接正则 */
const FLOMO_MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(https:\/\/v\.flomoapp\.com\/mine\/\?memo_id=([A-Za-z0-9]+)\)/g;

/** 纯文本 URL 格式的 flomo memo 链接正则 */
const FLOMO_PLAIN_URL_REGEX = /https:\/\/v\.flomoapp\.com\/mine\/\?memo_id=([A-Za-z0-9]+)/g;

/**
 * 将 markdown 中的 flomo memo 链接替换为 Obsidian 内部链接
 *
 * 同时处理两种格式：
 * 1. Markdown 链接: [文本](https://v.flomoapp.com/mine/?memo_id=XXX)
 * 2. 纯文本 URL: https://v.flomoapp.com/mine/?memo_id=XXX
 *
 * @param markdown - 原始 markdown 内容
 * @param index - slug -> 本地文件路径 的索引
 * @param linkStyle - 链接格式：wikilink 或 markdown
 * @returns 替换后的 markdown 内容
 */
export function rewriteFlomoLinks(
  markdown: string,
  index: BacklinkIndex,
  linkStyle: BacklinkLinkStyle = 'wikilink'
): string {
  if (!index.size()) {
    return markdown;
  }

  // 第一步：处理 Markdown 链接格式
  let result = markdown.replace(FLOMO_MARKDOWN_LINK_REGEX, (match, text: string, slug: string) => {
    const targetPath = index.get(slug);
    if (!targetPath) {
      return match;
    }
    const displayText = text.trim() || slug;
    return formatLink(targetPath, displayText, linkStyle);
  });

  // 第二步：处理纯文本 URL 格式
  result = result.replace(FLOMO_PLAIN_URL_REGEX, (match, slug: string) => {
    const targetPath = index.get(slug);
    if (!targetPath) {
      return match;
    }
    // 纯 URL 时，默认使用目标文件 basename 作为显示文本
    const displayText = targetPath.split('/').pop() || slug;
    return formatLink(targetPath, displayText, linkStyle);
  });

  return result;
}

function formatLink(targetPath: string, displayText: string, linkStyle: BacklinkLinkStyle): string {
  if (linkStyle === 'wikilink') {
    return `[[${targetPath}|${displayText}]]`;
  } else {
    return `[${displayText}](${targetPath}.md)`;
  }
}
