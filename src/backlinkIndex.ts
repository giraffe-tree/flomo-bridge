/**
 * 反向链接索引构建器
 *
 * 扫描目标目录下所有已同步的 flomo 笔记，建立 slug -> 文件路径 的映射
 */

import { App, TFile } from 'obsidian';

export class BacklinkIndex {
  private app: App;
  private targetDir: string;
  private index: Map<string, string> = new Map();

  constructor(app: App, targetDir: string) {
    this.app = app;
    this.targetDir = targetDir.replace(/^\.?\//, '').replace(/\/+$/, '');
  }

  /**
   * 根据 slug 获取对应的本地文件路径（相对于 vault root，不含 .md 后缀）
   */
  get(slug: string): string | undefined {
    return this.index.get(slug);
  }

  /**
   * 扫描目标目录，构建索引
   */
  build(): void {
    this.index.clear();

    const allFiles = this.app.vault.getMarkdownFiles();
    const targetPrefix = this.targetDir ? `${this.targetDir}/` : '';

    for (const file of allFiles) {
      // 只处理目标目录下的文件，排除 attachments
      if (!file.path.startsWith(targetPrefix) || file.path.includes('/attachments/')) {
        continue;
      }

      const slug = this.extractSlug(file);
      if (slug) {
        // 存储相对路径（不含 .md 后缀），用于 Wikilink
        const pathWithoutExt = file.path.replace(/\.md$/, '');
        this.index.set(slug, pathWithoutExt);
      }
    }
  }

  /**
   * 提取文件对应的 slug
   *
   * 优先使用 metadataCache，失败则回退到手动解析 frontmatter
   */
  private extractSlug(file: TFile): string | null {
    // 1. 尝试从 metadataCache 读取
    const cache = this.app.metadataCache.getCache(file.path);
    const frontmatterSlug = cache?.frontmatter?.slug;
    if (typeof frontmatterSlug === 'string' && frontmatterSlug.trim()) {
      return frontmatterSlug.trim();
    }

    // 2. 从文件名提取（备用）
    const match = file.name.match(/_([A-Za-z0-9]+)\.md$/);
    if (match) {
      return match[1];
    }

    return null;
  }

  /**
   * 获取索引大小（用于调试）
   */
  size(): number {
    return this.index.size;
  }
}
