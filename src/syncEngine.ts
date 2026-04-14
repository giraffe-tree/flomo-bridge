/**
 * Flomo 同步引擎
 *
 * 处理全量/增量同步、去重、落盘、游标保存
 */

import { App, TAbstractFile, TFile, TFolder, Notice, Platform, requestUrl } from 'obsidian';
import { FlomoClient, FlomoApiError } from './flomoClient';
import {
  FlomoMemo,
  FlomoFile,
  SyncStats,
  SyncCursor,
  FileOperationResult,
} from './types';
import { FlomoSyncSettings } from './settings';
import {
  memoToMarkdown,
  generateFilename,
  extractSlugFromFilename,
  parseTimestamp,
  isImage,
  isAudio,
  getExtensionFromUrl,
  extractExifDateTime,
  extractImageIdFromUrl,
} from './formatter';
import { BacklinkIndex } from './backlinkIndex';
import { rewriteFlomoLinks, BacklinkLinkStyle } from './backlinkRewriter';

/** 同步进度回调 */
export interface SyncProgress {
  page: number;
  pageCount: number;
  totalCount: number;
  status: 'fetching' | 'processing' | 'completed' | 'error';
  message?: string;
  /** 当前已处理数量（实时递增） */
  processedCount?: number;
  /** 实时统计 */
  stats?: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    deleted: number;
  };
  /** B-C 段（真正新增内容）的统计 */
  newContentStats?: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    deleted: number;
    total: number;
  };
  /** A-B 段（容错缓冲区）的统计 */
  bufferZoneStats?: {
    created: number;
    updated: number;
    total: number;
  };
  /** 错误对象（仅在 status 为 error 时存在） */
  error?: FlomoApiError;
}

/** 同步引擎 */
export class SyncEngine {
  private client: FlomoClient;
  private settings: FlomoSyncSettings;
  private app: App;
  private onProgress?: (progress: SyncProgress) => void;
  private debug: boolean;

  constructor(
    client: FlomoClient,
    settings: FlomoSyncSettings,
    app: App,
    onProgress?: (progress: SyncProgress) => void
  ) {
    this.client = client;
    this.settings = settings;
    this.app = app;
    this.onProgress = onProgress;
    this.debug = settings.debugMode;
  }

  /** 日志输出 */
  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[FlomoSync]', ...args);
    }
  }

  /**
   * 执行同步
   *
   * @param fullSync - 是否执行全量同步（重置游标）
   * @returns 同步统计
   */
  async sync(fullSync: boolean = false): Promise<SyncStats> {
    const stats: SyncStats = {
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      deleted: 0,
      total: 0,
      startTime: new Date(),
      // 初始化 B-C 段统计
      newContent: {
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        deleted: 0,
        total: 0,
      },
      // 初始化 A-B 段统计（只记录 created/updated）
      bufferZone: {
        created: 0,
        updated: 0,
        total: 0,
      },
    };

    // 1. 确保目标目录存在
    const targetDir = await this.ensureTargetDir();

    // 1.5 构建反向链接索引
    let backlinkIndex: BacklinkIndex | undefined;
    if (this.settings.enableBacklinks) {
      backlinkIndex = new BacklinkIndex(this.app, this.settings.targetDir);
      await backlinkIndex.build();
      this.log('Backlink index built:', backlinkIndex.size(), 'entries');
    }

    // 2. 确定同步游标
    let cursor: SyncCursor;
    // 记录原始游标时间（B点），用于区分 A-B 段和 B-C 段
    let originalCursorTime: number;

    if (fullSync) {
      cursor = { latest_updated_at: 0, latest_slug: '' };
      originalCursorTime = 0;
    } else {
      cursor = { ...this.settings.cursor };
      originalCursorTime = cursor.latest_updated_at; // 保存 B 点时间
      // 容错：减去 1 天（A点）
      if (cursor.latest_updated_at > 86400) {
        cursor.latest_updated_at -= 86400;
      }
    }

    this.log('Starting sync with cursor:', cursor, 'originalCursorTime (B点):', originalCursorTime);

    // 3. 遍历所有页面
    try {
      for await (const items of this.client.iterMemos(
        cursor.latest_updated_at,
        (page, count, cur) => {
          this.onProgress?.({
            page,
            pageCount: count,
            totalCount: stats.total,
            status: 'fetching',
            message: `获取第 ${page} 页，${count} 条`,
          });
        }
      )) {
        // 更新进度
        this.onProgress?.({
          page: 0,
          pageCount: items.length,
          totalCount: stats.total,
          status: 'processing',
          message: `处理 ${items.length} 条笔记`,
        });

        // 处理每条 memo
        for (const memo of items) {
          try {
            const result = await this.processMemo(memo, targetDir, backlinkIndex);

            // 判断属于哪一段
            const memoUpdatedAt = parseTimestamp(memo.updated_at);
            const isInBufferZone = !fullSync && memoUpdatedAt <= originalCursorTime;

            // A-B 段的 skipped 不计入任何统计（完全忽略）
            const isSkippedInBufferZone = isInBufferZone && result === 'skipped';

            if (isSkippedInBufferZone) {
              // A-B 段 skipped：不计入 totals，只记日志
              this.log(`[A-B段/skipped-完全忽略] slug=${memo.slug}, updated_at=${memo.updated_at} (${memoUpdatedAt}) <= cursor (${originalCursorTime})`);
            } else {
              // 其他情况：计入总统计
              stats[result]++;
              stats.total++;

              if (isInBufferZone) {
                // A-B 段 created/updated：计入 bufferZone
                if (result === 'created' || result === 'updated') {
                  stats.bufferZone![result]++;
                  stats.bufferZone!.total++;
                }
                this.log(`[A-B段/${result}] slug=${memo.slug}, updated_at=${memo.updated_at} (${memoUpdatedAt}) <= cursor (${originalCursorTime})`);
              } else {
                // B-C 段：计入 newContent
                stats.newContent![result]++;
                stats.newContent!.total++;
                this.log(`[B-C段/${result}] slug=${memo.slug}, updated_at=${memo.updated_at} (${memoUpdatedAt}) > cursor (${originalCursorTime})`);
              }
            }
          } catch (error) {
            this.log('Failed to process memo:', memo.slug, error);

            // 失败也按时间段分类
            const memoUpdatedAt = parseTimestamp(memo.updated_at);
            const isInBufferZone = !fullSync && memoUpdatedAt <= originalCursorTime;

            if (isInBufferZone) {
              // A-B 段失败：不计入（和 skipped 一样处理）
              this.log(`[A-B段/failed-完全忽略] slug=${memo.slug}, updated_at=${memo.updated_at} (${memoUpdatedAt}) <= cursor (${originalCursorTime})`);
            } else {
              // B-C 段失败：正常计入
              stats.failed++;
              stats.total++;
              if (stats.newContent) {
                stats.newContent.failed++;
                stats.newContent.total++;
              }
            }
          }

          // 实时更新进度 - 优先展示 B-C 段统计
          this.onProgress?.({
            page: 0,
            pageCount: items.length,
            totalCount: stats.total,
            status: 'processing',
            processedCount: stats.total,
            stats: {
              created: stats.created,
              updated: stats.updated,
              skipped: stats.skipped,
              failed: stats.failed,
              deleted: stats.deleted,
            },
            newContentStats: stats.newContent,
            bufferZoneStats: stats.bufferZone,
            message: `处理中: ${stats.total} 条 (新增 ${stats.newContent?.created || 0})`,
          });
        }

        // 更新游标（实时保存）
        const lastMemo = items[items.length - 1];
        if (lastMemo) {
          this.settings.cursor = {
            latest_updated_at: parseTimestamp(lastMemo.updated_at),
            latest_slug: lastMemo.slug,
          };
          // 注意：这里不直接调用 saveSettings，由上层控制
        }
      }

      stats.endTime = new Date();

      // 使用 B-C 段统计生成完成消息
      const nc = stats.newContent;
      const bz = stats.bufferZone;
      const completionMessage = nc && nc.total > 0
        ? `同步完成：新增 ${nc.created}，更新 ${nc.updated}，跳过 ${nc.skipped}${nc.deleted > 0 ? '，删除 ' + nc.deleted : ''}`
        : `同步完成：新增 ${stats.created}，更新 ${stats.updated}，跳过 ${stats.skipped}${stats.deleted > 0 ? '，删除 ' + stats.deleted : ''}`;

      // 输出详细统计报告
      this.log('========== 同步统计报告 ==========');
      this.log(`总处理: ${stats.total} 条 (新增 ${stats.created} / 更新 ${stats.updated} / 跳过 ${stats.skipped} / 删除 ${stats.deleted} / 失败 ${stats.failed})`);
      if (!fullSync) {
        this.log(`原始游标点 (B点): ${originalCursorTime} (${new Date(originalCursorTime * 1000).toISOString()})`);
        this.log(`容错游标点 (A点): ${cursor.latest_updated_at} (${new Date(cursor.latest_updated_at * 1000).toISOString()})`);
        this.log(`B-C段 (真正新增): ${nc?.total || 0} 条 (新增 ${nc?.created || 0} / 更新 ${nc?.updated || 0} / 跳过 ${nc?.skipped || 0} / 删除 ${nc?.deleted || 0} / 失败 ${nc?.failed || 0})`);
        this.log(`A-B段 (容错缓冲): ${bz?.total || 0} 条 (新增 ${bz?.created || 0} / 更新 ${bz?.updated || 0}) - 注意: skipped 不计入此段`);
      } else {
        this.log('全量同步: 所有内容计入 B-C 段');
      }
      this.log('===================================');

      this.onProgress?.({
        page: 0,
        pageCount: 0,
        totalCount: stats.total,
        status: 'completed',
        message: completionMessage,
      });

      return stats;
    } catch (error) {
      stats.endTime = new Date();

      if (error instanceof FlomoApiError) {
        this.onProgress?.({
          page: 0,
          pageCount: 0,
          totalCount: stats.total,
          status: 'error',
          message: error.message,
          error: error,
        });
        throw error;
      }

      const err = error as Error;
      // 将普通 Error 转换为 FlomoApiError 以便统一处理
      const flomoError = new FlomoApiError(err.message);
      this.onProgress?.({
        page: 0,
        pageCount: 0,
        totalCount: stats.total,
        status: 'error',
        message: err.message,
        error: flomoError,
      });
      throw error;
    }
  }

  /**
   * 处理单条 memo
   *
   * @param memo - flomo memo
   * @param targetDir - 目标目录
   * @returns 操作结果
   */
  private async processMemo(
    memo: FlomoMemo,
    targetDir: TFolder,
    backlinkIndex?: BacklinkIndex
  ): Promise<FileOperationResult> {
    const slug = memo.slug;
    const newFilename = generateFilename(memo);
    const newPath = `${this.settings.targetDir}/${newFilename}`;

    this.log('Processing memo:', slug, '->', newFilename);

    // 添加诊断日志：memo 关键信息
    console.log('[FlomoSync Debug] Processing memo:', {
      slug: memo.slug,
      created_at: memo.created_at,
      updated_at: memo.updated_at,
      deleted_at: memo.deleted_at,
      tags: memo.tags,
      filesCount: memo.files?.length || 0,
    });

    // 0. 检查是否已在服务端删除
    if (memo.deleted_at != null && memo.deleted_at !== '') {
      const existingFile = await this.findFileBySlug(slug, targetDir);
      if (existingFile) {
        this.log('Memo deleted remotely, removing local file:', existingFile.path);
        await this.app.vault.delete(existingFile);
        await this.deleteMemoAttachments(slug);
        console.log('[FlomoSync Debug] -> DELETED (remote deleted_at)');
        return 'deleted';
      }
      console.log('[FlomoSync Debug] -> SKIPPED (remote deleted, no local file)');
      return 'skipped';
    }

    // 1. 下载附件（如果需要）
    const attachmentPaths = new Map<string, string>();
    if (this.settings.downloadAttachments && memo.files && memo.files.length > 0) {
      // 并发下载，每次最多3个
      const CONCURRENT_LIMIT = 3;
      for (let i = 0; i < memo.files.length; i += CONCURRENT_LIMIT) {
        const batch = memo.files.slice(i, i + CONCURRENT_LIMIT);
        const batchResults = await Promise.all(
          batch.map(file => this.downloadAttachment(file, memo))
        );
        batch.forEach((file, index) => {
          const localPath = batchResults[index];
          if (localPath) {
            attachmentPaths.set(file.url, localPath);
          }
        });
      }
    }

    // 添加诊断日志：附件路径映射
    console.log('[FlomoSync Debug] Attachment paths:', Object.fromEntries(attachmentPaths));

    // 2. 生成 Markdown 内容
    let content = memoToMarkdown(memo, attachmentPaths);

    // 2.5 反向链接替换
    if (backlinkIndex) {
      content = rewriteFlomoLinks(content, backlinkIndex, this.settings.backlinkLinkStyle);
    }

    // 添加诊断日志：生成内容的前200字符
    console.log('[FlomoSync Debug] Generated content (first 200 chars):', content.slice(0, 200));

    // 3. 检查是否已存在同 slug 的文件
    const existingFile = await this.findFileBySlug(slug, targetDir);

    if (existingFile) {
      // 3a. 文件已存在
      const existingContent = await this.app.vault.adapter.read(existingFile.path);


      if (existingContent === content) {
        // 内容完全相同，跳过
        console.log('[FlomoSync Debug] -> SKIPPED (content identical)');
        return 'skipped';
      }

      // 内容不同，需要更新
      console.log('[FlomoSync Debug] -> UPDATED (content different)');
      console.log('[FlomoSync Debug] Filename check - existing:', existingFile.name, 'new:', newFilename);

      if (existingFile.name !== newFilename) {
        // 文件名变化，先删除旧文件
        await this.app.vault.delete(existingFile);
        await this.app.vault.create(newPath, content);
      } else {
        // 文件名相同，直接修改
        await this.app.vault.modify(existingFile, content);
      }
      return 'updated';
    } else {
      // 3b. 新文件
      console.log('[FlomoSync Debug] -> CREATED (file not found for slug:', slug, ')');
      await this.app.vault.create(newPath, content);
      return 'created';
    }
  }

  /**
   * 根据 slug 查找文件
   *
   * @param slug - memo slug
   * @param dir - 搜索目录
   * @returns 文件或 null
   */
  private async findFileBySlug(
    slug: string,
    dir: TFolder
  ): Promise<TFile | null> {
    const pattern = new RegExp(`_${slug}\\.md$`);

    for (const child of dir.children) {
      if (child instanceof TFile && pattern.test(child.name)) {
        return child;
      }
    }

    return null;
  }

  /**
   * 删除与指定 slug 相关的附件
   *
   * 附件文件名中通常包含 slug，据此在 attachments 目录下查找并删除
   */
  private async deleteMemoAttachments(slug: string): Promise<void> {
    const attachmentsDir = `${this.settings.targetDir}/attachments`;
    const folder = this.app.vault.getAbstractFileByPath(attachmentsDir);
    if (!(folder instanceof TFolder)) {
      return;
    }

    const pattern = new RegExp(slug);
    const filesToDelete: TFile[] = [];

    const collectFiles = (dir: TFolder) => {
      for (const child of dir.children) {
        if (child instanceof TFile && pattern.test(child.name)) {
          filesToDelete.push(child);
        } else if (child instanceof TFolder) {
          collectFiles(child);
        }
      }
    };

    collectFiles(folder);

    for (const file of filesToDelete) {
      this.log('Deleting attachment:', file.path);
      await this.app.vault.delete(file);
    }
  }

  /**
   * 下载附件
   *
   * @param file - 附件信息
   * @param memo - 所属 memo
   * @returns 本地相对路径（相对于 vault root）或 null
   */
  private async downloadAttachment(
    file: FlomoFile,
    memo: FlomoMemo
  ): Promise<string | null> {
    const url = file.url;
    const filename = file.name || 'unnamed';

    console.log('[FlomoSync Debug] downloadAttachment - filename:', filename, 'url:', url);

    // 检查是否支持的格式
    const isImg = isImage(filename) || isImage(url);
    const isAud = isAudio(filename) || isAudio(url);

    console.log('[FlomoSync Debug] downloadAttachment - isImg:', isImg, 'isAud:', isAud);

    if (!isImg && !isAud) {
      console.log('[FlomoSync Debug] downloadAttachment - unsupported format, skipping');
      return null;
    }

    // 提取原始扩展名（优先从 URL 获取，因为 file.name 可能没有扩展名）
    const ext = getExtensionFromUrl(file.url) || getExtensionFromUrl(file.name) || '';

    // 先下载文件到内存（为了解析 EXIF）
    let buffer: ArrayBuffer | null = null;
    try {
      this.log('Downloading attachment:', filename);
      buffer = await this.client.downloadAttachment(url);
      if (!buffer) {
        return null;
      }
    } catch (error) {
      this.log('Failed to download attachment:', filename, error);
      return null;
    }

    // 生成文件名：优先从 URL 提取图片标识，确保同一图片始终使用相同文件名
    let localFilename = extractImageIdFromUrl(file.url);

    // 如果无法从 URL 提取标识，则回退到使用 memo slug + 时间戳
    if (!localFilename) {
      const fileTime = new Date(memo.updated_at);
      const timePart = `${String(fileTime.getHours()).padStart(2, '0')}_${String(fileTime.getMinutes()).padStart(2, '0')}_${String(fileTime.getSeconds()).padStart(2, '0')}`;
      localFilename = `${memo.slug}_${timePart}${ext}`;
    }

    // 构建存储路径（基于 memo.created_at 的日期目录）
    const createdAt = memo.created_at || '';
    const dateDir = createdAt.length >= 10
      ? `${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}/${createdAt.slice(8, 10)}`
      : 'unknown';
    const localDir = `${this.settings.targetDir}/attachments/${dateDir}`;
    const localPath = `${localDir}/${localFilename}`;

    // 检查文件是否已存在
    if (await this.app.vault.adapter.exists(localPath)) {
      this.log('Attachment already exists:', localPath);
      return localPath;
    }

    // 保存文件
    try {
      await this.ensureDir(localDir);
      const uint8Array = new Uint8Array(buffer);
      await this.app.vault.adapter.writeBinary(localPath, uint8Array);
      this.log('Attachment saved:', localPath);
      return localPath;
    } catch (error) {
      this.log('Failed to save attachment:', localPath, error);
      return null;
    }
  }

  /**
   * 确保目标目录存在
   *
   * @returns 目标文件夹
   */
  private async ensureTargetDir(): Promise<TFolder> {
    const dirPath = this.settings.targetDir;

    // 检查目录是否存在
    const existingFolder = this.app.vault.getAbstractFileByPath(dirPath);
    if (existingFolder instanceof TFolder) {
      return existingFolder;
    }

    // 递归创建目录
    await this.ensureDir(dirPath);

    const folder = this.app.vault.getAbstractFileByPath(dirPath);
    if (folder instanceof TFolder) {
      return folder;
    }

    throw new Error(`Failed to create target directory: ${dirPath}`);
  }

  /**
   * 清理本地已删除的 memo
   *
   * 全量拉取远程所有 memo 的 slug，删除本地存在但远程不存在或已被标记删除的文件
   */
  async cleanupDeletedMemos(
    onProgress?: (progress: { status: 'fetching' | 'processing' | 'completed' | 'error'; message?: string }) => void
  ): Promise<{ scanned: number; deleted: number }> {
    const targetDir = this.settings.targetDir.replace(/^\.?\//, '').replace(/\/+$/, '');
    const targetPrefix = targetDir ? `${targetDir}/` : '';
    this.log('[Cleanup] START targetDir:', targetDir, 'targetPrefix:', targetPrefix);

    // 1. 全量拉取所有远程 slug（区分正常 slug 与已删除 slug）
    onProgress?.({ status: 'fetching', message: '正在拉取远程记录...' });
    const remoteSlugs = new Set<string>();
    const deletedSlugs = new Set<string>();

    try {
      for await (const items of this.client.iterMemos(0, (page, count) => {
        this.log(`[Cleanup] fetching page ${page}, got ${count} items. Cumulative remote slugs so far: ${remoteSlugs.size}, deleted: ${deletedSlugs.size}`);
        onProgress?.({ status: 'fetching', message: `拉取第 ${page} 页，${count} 条` });
      })) {
        for (const memo of items) {
          if (!memo.slug) continue;

          remoteSlugs.add(memo.slug);
          if (memo.deleted_at != null && memo.deleted_at !== '') {
            deletedSlugs.add(memo.slug);
          }
        }
        this.log('[Cleanup] After processing page, cumulative remote slugs:', remoteSlugs.size, 'deleted:', deletedSlugs.size);
      }
    } catch (error) {
      this.log('[Cleanup] ERROR while fetching remote memos:', error);
      onProgress?.({ status: 'error', message: '拉取远程记录失败' });
      throw error;
    }

    this.log('[Cleanup] Remote slugs fetched total:', remoteSlugs.size, 'deleted:', deletedSlugs.size);
    onProgress?.({ status: 'processing', message: `远程共 ${remoteSlugs.size} 条（已删除 ${deletedSlugs.size} 条），开始比对本地文件...` });

    // 2. 扫描本地文件
    const allFiles = this.app.vault.getMarkdownFiles();
    this.log('[Cleanup] Total markdown files in vault:', allFiles.length);

    let scanned = 0;
    let deleted = 0;

    for (const file of allFiles) {
      const shouldScan = file.path.startsWith(targetPrefix) && !file.path.includes('/attachments/');

      if (!shouldScan) {
        continue;
      }

      scanned++;
      const slug = this.extractSlugFromFile(file);
      const inRemote = slug ? remoteSlugs.has(slug) : false;
      const isDeleted = slug ? deletedSlugs.has(slug) : false;

      if (slug && (!inRemote || isDeleted)) {
        const reason = isDeleted ? 'remote deleted' : 'not in remote';
        this.log('[Cleanup] DELETING local memo (' + reason + '):', file.path, 'slug:', slug);
        await this.app.vault.delete(file);
        await this.deleteMemoAttachments(slug);
        deleted++;
      } else {
        this.log('[Cleanup] KEEPING local memo:', file.path, 'slug:', slug, 'reason:', inRemote ? 'exists in remote' : 'no slug extracted');
      }
    }

    this.log('[Cleanup] COMPLETE - scanned:', scanned, 'deleted:', deleted);
    onProgress?.({ status: 'completed', message: `清理完成：扫描 ${scanned} 条，删除 ${deleted} 条` });
    return { scanned, deleted };
  }

  /**
   * 从本地文件提取 slug（仅使用文件名，避免 metadataCache 延迟或不一致）
   */
  private extractSlugFromFile(file: TFile): string | null {
    const match = file.name.match(/_([A-Za-z0-9]+)\.md$/);
    return match ? match[1] : null;
  }

  /**
   * 修复所有本地笔记的反向链接
   *
   * 遍历目标目录下所有 markdown 文件，重新执行反向链接替换
   */
  async repairBacklinks(): Promise<{ scanned: number; updated: number }> {
    const targetDir = this.settings.targetDir.replace(/^\.?\//, '').replace(/\/+$/, '');
    const targetPrefix = targetDir ? `${targetDir}/` : '';

    const backlinkIndex = new BacklinkIndex(this.app, this.settings.targetDir);
    await backlinkIndex.build();
    this.log('Repair backlinks - index built:', backlinkIndex.size(), 'entries');

    const allFiles = this.app.vault.getMarkdownFiles();
    let scanned = 0;
    let updated = 0;

    for (const file of allFiles) {
      if (!file.path.startsWith(targetPrefix) || file.path.includes('/attachments/')) {
        continue;
      }

      scanned++;
      const content = await this.app.vault.adapter.read(file.path);
      const newContent = rewriteFlomoLinks(content, backlinkIndex, this.settings.backlinkLinkStyle);

      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
        updated++;
        this.log('Repaired backlinks in:', file.path);
      }
    }

    this.log('Repair backlinks complete - scanned:', scanned, 'updated:', updated);
    return { scanned, updated };
  }

  /**
   * 确保目录存在（递归创建）
   *
   * @param path - 目录路径
   */
  private async ensureDir(path: string): Promise<void> {
    const parts = path.split('/').filter((p) => p);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }
}
