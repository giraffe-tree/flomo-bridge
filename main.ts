/**
 * Flomo Sync Plugin for Obsidian
 *
 * 将 flomo 笔记增量同步到 Obsidian vault 中
 */

const PLUGIN_VERSION = '1.0.1'; // 每次发布时更新

import { Plugin, Notice } from 'obsidian';
import { FlomoSyncSettings, DEFAULT_SETTINGS, FlomoSyncSettingTab } from './src/settings';
import { FlomoClient, FlomoApiError } from './src/flomoClient';
import { SyncEngine } from './src/syncEngine';
import { StatusBarManager, addStatusBarStyles } from './src/statusBar';

/** 主插件类 */
export default class FlomoSyncPlugin extends Plugin {
  settings!: FlomoSyncSettings;
  private statusBar!: StatusBarManager;
  private syncIntervalId: number | null = null;
  isSyncing: boolean = false;  // public for settings panel access
  settingsTab?: FlomoSyncSettingTab;  // public for sync completion refresh

  async onload(): Promise<void> {
    console.debug(`[FlomoSync] Plugin loaded, version: ${PLUGIN_VERSION}`);

    // 1. 加载设置
    await this.loadSettings();

    // 2. 添加状态栏样式
    addStatusBarStyles(this);

    // 3. 初始化状态栏
    this.statusBar = new StatusBarManager(this);

    // 4. 添加设置面板
    this.settingsTab = new FlomoSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // 5. 注册命令
    this.registerCommands();

    // 6. 设置自动同步
    this.setupAutoSync();

    // 7. 初始化状态栏显示
    this.statusBar.setStatus('idle');

    // 8. 如果有上次同步记录，显示统计
    if (this.settings.cursor.latest_updated_at > 0) {
      // last sync time available
    }
  }

  onunload(): void {
    console.debug('Unloading Flomo Sync plugin');

    // 清理自动同步定时器
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    // 清理状态栏
    this.statusBar?.unload();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 注册命令
   */
  private registerCommands(): void {
    // 命令：立即同步
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => {
        void this.performSync();
      },
    });

    // 命令：全量同步
    this.addCommand({
      id: 'sync-full',
      name: 'Sync full',
      callback: () => {
        void this.performFullSync();
      },
    });

    // 命令：打开设置
    this.addCommand({
      id: 'open-settings',
      name: 'Open settings',
      callback: () => this.openSettings(),
    });

    // 命令：修复反向链接并清理已删除记录
    this.addCommand({
      id: 'repair-and-cleanup',
      name: 'Repair backlinks & cleanup deleted memos',
      callback: () => {
        void this.performRepairAndCleanup();
      },
    });
  }

  /**
   * 设置自动同步
   */
  setupAutoSync(): void {
    // 清理现有定时器
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    const interval = this.settings.syncInterval;
    if (interval > 0) {
      // 转换为毫秒
      const ms = interval * 1000;
      this.syncIntervalId = window.setInterval(() => {
        void this.performSync();
      }, ms);
    }
  }

  /**
   * 执行增量同步
   */
  async performSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Sync in progress...');
      return;
    }

    if (!this.settings.token) {
      new Notice('Access token not configured. Open settings to add it.', 5000);
      this.openSettings();
      return;
    }

    this.isSyncing = true;
    this.statusBar.setStatus('syncing', '正在同步...');
    let completedMessage = '同步完成';

    try {
      const client = new FlomoClient({
        token: this.settings.token,
        targetDir: this.settings.targetDir,
        downloadAttachments: this.settings.downloadAttachments,
        syncInterval: this.settings.syncInterval,
        debugMode: this.settings.debugMode,
      });

      const engine = new SyncEngine(client, this.settings, this.app, (progress) => {
        if (progress.status === 'error') {
          // 提取错误详情
          const errorDetails: Partial<import('./src/types').ErrorDetails> = {};
          if (progress.error instanceof FlomoApiError) {
            errorDetails.code = progress.error.code;
            errorDetails.status = progress.error.status;
          }
          this.statusBar.setStatus('error', progress.message || '同步失败', errorDetails);
        } else if (progress.status === 'completed') {
          // 最终成功状态延后到 stats 持久化后，避免读取旧的 lastSyncStats
          completedMessage = progress.message || completedMessage;
        } else if (progress.status === 'processing' && progress.processedCount !== undefined && progress.stats) {
          // 实时更新数字显示（+++效果）- 传递 newContentStats 和 bufferZoneStats
          this.statusBar.updateProgress(
            progress.processedCount,
            progress.stats,
            progress.newContentStats,
            progress.bufferZoneStats
          );
        } else {
          this.statusBar.setStatus('syncing', progress.message);
        }
      });

      const stats = await engine.sync(false);

      // 保存更新后的游标和统计
      const duration = stats.endTime
        ? Math.round((stats.endTime.getTime() - stats.startTime.getTime()) / 1000)
        : 0;

      this.settings.lastSyncStats = {
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        failed: stats.failed,
        deleted: stats.deleted,
        total: stats.total,
        newContent: stats.newContent,
        bufferZone: stats.bufferZone,
        timestamp: Date.now(),
        duration: duration,
      };
      await this.saveSettings();
      this.statusBar.setStatus('success', completedMessage);

      // 刷新设置界面以显示最新同步时间
      this.settingsTab?.refresh();

      // 增量同步仅在状态栏显示统计，不弹出 Notice 通知
      // 状态栏通过 setStatus('success') 和 updateProgress() 已显示详细统计

    } catch (error) {
      this.handleSyncError(error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 执行全量同步
   */
  async performFullSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Sync in progress...');
      return;
    }

    if (!this.settings.token) {
      new Notice('Access token not configured. Open settings to add it.', 5000);
      this.openSettings();
      return;
    }

    this.isSyncing = true;
    this.statusBar.setStatus('syncing', '正在全量同步...');
    let completedMessage = '全量同步完成';

    try {
      const client = new FlomoClient({
        token: this.settings.token,
        targetDir: this.settings.targetDir,
        downloadAttachments: this.settings.downloadAttachments,
        syncInterval: this.settings.syncInterval,
        debugMode: this.settings.debugMode,
      });

      const engine = new SyncEngine(client, this.settings, this.app, (progress) => {
        if (progress.status === 'error') {
          // 提取错误详情
          const errorDetails: Partial<import('./src/types').ErrorDetails> = {};
          if (progress.error instanceof FlomoApiError) {
            errorDetails.code = progress.error.code;
            errorDetails.status = progress.error.status;
          }
          this.statusBar.setStatus('error', progress.message || '同步失败', errorDetails);
        } else if (progress.status === 'completed') {
          // 最终成功状态延后到 stats 持久化后，避免读取旧的 lastSyncStats
          completedMessage = progress.message || completedMessage;
        } else if (progress.status === 'processing' && progress.processedCount !== undefined && progress.stats) {
          // 实时更新数字显示（+++效果）- 传递 newContentStats 和 bufferZoneStats
          this.statusBar.updateProgress(
            progress.processedCount,
            progress.stats,
            progress.newContentStats,
            progress.bufferZoneStats
          );
        } else {
          this.statusBar.setStatus('syncing', progress.message);
        }
      });

      const stats = await engine.sync(true); // true = full sync

      // 保存更新后的游标和统计
      const duration = stats.endTime
        ? Math.round((stats.endTime.getTime() - stats.startTime.getTime()) / 1000)
        : 0;

      this.settings.lastSyncStats = {
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        failed: stats.failed,
        deleted: stats.deleted,
        total: stats.total,
        newContent: stats.newContent,
        bufferZone: stats.bufferZone,
        timestamp: Date.now(),
        duration: duration,
      };
      await this.saveSettings();
      this.statusBar.setStatus('success', completedMessage);

      // 刷新设置界面以显示最新同步时间
      this.settingsTab?.refresh();

      new Notice(
        `Flomo 全量同步完成\n` +
        `新增: ${stats.created} | 更新: ${stats.updated}\n` +
        `跳过: ${stats.skipped} | 删除: ${stats.deleted} | 失败: ${stats.failed}\n` +
        `耗时: ${duration}s`,
        4000
      );

    } catch (error) {
      this.handleSyncError(error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 修复反向链接
   */
  async performRepairBacklinks(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Sync in progress, please try again later');
      return;
    }

    this.isSyncing = true;
    this.statusBar.setStatus('syncing', '正在修复反向链接...');

    try {
      const client = new FlomoClient({
        token: this.settings.token,
        targetDir: this.settings.targetDir,
        downloadAttachments: this.settings.downloadAttachments,
        syncInterval: this.settings.syncInterval,
        debugMode: this.settings.debugMode,
      });

      const engine = new SyncEngine(client, this.settings, this.app);
      const result = await engine.repairBacklinks();

      this.statusBar.setStatus('success', `反向链接修复完成：扫描 ${result.scanned} 条，更新 ${result.updated} 条`);
      new Notice(`反向链接修复完成\n扫描: ${result.scanned} 条\n更新: ${result.updated} 条`, 4000);
    } catch (error) {
      const err = error as Error;
      new Notice(`修复失败: ${err.message}`, 5000);
      this.statusBar.setStatus('error', '修复反向链接失败');
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 清理已删除的 memo
   */
  async performCleanupDeletedMemos(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Sync in progress, please try again later');
      return;
    }

    // confirm removed per Obsidian plugin guidelines; use settings panel for cleanup

    this.isSyncing = true;
    this.statusBar.setStatus('syncing', '正在清理已删除记录...');

    try {
      const client = new FlomoClient({
        token: this.settings.token,
        targetDir: this.settings.targetDir,
        downloadAttachments: this.settings.downloadAttachments,
        syncInterval: this.settings.syncInterval,
        debugMode: this.settings.debugMode,
      });

      const engine = new SyncEngine(client, this.settings, this.app);
      const result = await engine.cleanupDeletedMemos((progress) => {
        if (progress.message) {
          this.statusBar.setStatus('syncing', progress.message);
        }
      });

      this.statusBar.setStatus('success', `清理完成：扫描 ${result.scanned} 条，删除 ${result.deleted} 条`);
      new Notice(`清理完成\n扫描: ${result.scanned} 条\n删除: ${result.deleted} 条`, 4000);
    } catch (error) {
      const err = error as Error;
      new Notice(`清理失败: ${err.message}`, 5000);
      this.statusBar.setStatus('error', '清理失败');
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 修复反向链接并清理已删除记录
   */
  async performRepairAndCleanup(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Sync in progress, please try again later');
      return;
    }

    this.isSyncing = true;
    this.statusBar.setStatus('syncing', '正在修复...');

    try {
      const client = new FlomoClient({
        token: this.settings.token,
        targetDir: this.settings.targetDir,
        downloadAttachments: this.settings.downloadAttachments,
        syncInterval: this.settings.syncInterval,
        debugMode: this.settings.debugMode,
      });

      const engine = new SyncEngine(client, this.settings, this.app);

      // 1. 修复反向链接
      this.statusBar.setStatus('syncing', '正在修复反向链接...');
      const repairResult = await engine.repairBacklinks();

      // 2. 清理已删除记录
      this.statusBar.setStatus('syncing', '正在清理已删除记录...');
      const cleanupResult = await engine.cleanupDeletedMemos((progress) => {
        if (progress.message) {
          this.statusBar.setStatus('syncing', progress.message);
        }
      });

      this.statusBar.setStatus('success', '修复完成');
      new Notice(
        `修复完成\n` +
        `反向链接: 扫描 ${repairResult.scanned} 条，更新 ${repairResult.updated} 条\n` +
        `清理记录: 扫描 ${cleanupResult.scanned} 条，删除 ${cleanupResult.deleted} 条`,
        5000
      );
    } catch (error) {
      const err = error as Error;
      new Notice(`修复失败: ${err.message}`, 5000);
      this.statusBar.setStatus('error', '修复失败');
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 处理同步错误
   */
  private handleSyncError(error: unknown): void {

    if (error instanceof FlomoApiError) {
      if (error.status === 401 || error.code === -1) {
        new Notice('Flomo token 无效或已过期，请重新配置', 5000);
      } else if (error.status === 429) {
        new Notice('请求过于频繁，请稍后再试', 5000);
      } else {
        new Notice(`同步失败: ${error.message}`, 5000);
      }
    } else {
      const err = error as Error;
      new Notice(`同步失败: ${err.message}`, 5000);
    }

    this.statusBar.setStatus('error', '同步失败');
  }

  /**
   * 打开设置面板
   */
  openSettings(): void {
    // 打开设置面板并定位到本插件
    // @ts-expect-error - Obsidian internal API
    this.app.setting.open();
    // @ts-expect-error - Obsidian internal API
    this.app.setting.openTabById(this.manifest.id);
  }

  /**
   * 调试日志
   */
  log(...args: unknown[]): void {
    if (this.settings.debugMode) {
      console.debug('[FlomoSync]', ...args);
    }
  }
}
