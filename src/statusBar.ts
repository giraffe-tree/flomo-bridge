/**
 * 状态栏组件
 *
 * 显示最近同步时间/进度
 */

import { Plugin, moment, Menu, Notice, setIcon, Modal, App } from 'obsidian';
import type FlomoSyncPlugin from '../main';
import type { SyncStatus, ErrorDetails } from './types';
import { getTooltipManager } from './tooltip';

/** Obsidian 状态栏元素 */
type StatusBarItemElement = HTMLElement;

/** 错误详情弹窗 */
class ErrorDetailModal extends Modal {
  private errorDetails: ErrorDetails;
  private plugin: FlomoSyncPlugin;

  constructor(app: App, errorDetails: ErrorDetails, plugin: FlomoSyncPlugin) {
    super(app);
    this.errorDetails = errorDetails;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // 标题区域
    const headerEl = contentEl.createDiv({ cls: 'flomo-error-modal-header' });
    const iconEl = headerEl.createSpan({ cls: 'flomo-error-modal-icon' });
    setIcon(iconEl, 'alert-circle');
    headerEl.createEl('h2', { text: '同步失败', cls: 'flomo-error-modal-title' });

    // 错误详情区域
    const detailsEl = contentEl.createDiv({ cls: 'flomo-error-modal-details' });

    // 错误代码
    if (this.errorDetails.code !== undefined || this.errorDetails.status !== undefined) {
      const codeEl = detailsEl.createDiv({ cls: 'flomo-error-modal-row' });
      codeEl.createSpan({ text: '错误代码: ', cls: 'flomo-error-modal-label' });
      const codeValue = this.errorDetails.status !== undefined
        ? `HTTP ${this.errorDetails.status}`
        : `Code ${this.errorDetails.code}`;
      codeEl.createSpan({ text: codeValue, cls: 'flomo-error-modal-code' });
    }

    // 错误信息
    const messageEl = detailsEl.createDiv({ cls: 'flomo-error-modal-row' });
    messageEl.createSpan({ text: '错误信息: ', cls: 'flomo-error-modal-label' });
    messageEl.createSpan({ text: this.errorDetails.message, cls: 'flomo-error-modal-message' });

    // 时间戳
    const timeEl = detailsEl.createDiv({ cls: 'flomo-error-modal-row flomo-error-modal-time' });
    const timeStr = new Date(this.errorDetails.timestamp).toLocaleString('zh-CN');
    timeEl.createSpan({ text: `发生时间: ${timeStr}`, cls: 'flomo-error-modal-time-text' });

    // 按钮区域
    const buttonEl = contentEl.createDiv({ cls: 'flomo-error-modal-buttons' });

    // 重试按钮
    buttonEl.createEl('button', {
      text: '重试同步',
      cls: 'mod-cta',
    }).addEventListener('click', () => {
      this.close();
      void this.plugin.performSync();
    });

    // 查看设置按钮
    buttonEl.createEl('button', {
      text: '查看设置',
    }).addEventListener('click', () => {
      this.close();
      this.plugin.openSettings();
    });

    // 查看日志提示
    const hintEl = contentEl.createDiv({ cls: 'flomo-error-modal-hint' });
    hintEl.createEl('small', {
      text: '提示: 开启调试模式可查看详细日志',
      cls: 'flomo-error-modal-hint-text',
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/** 状态栏管理器 */
export class StatusBarManager {
  private plugin: FlomoSyncPlugin;
  private statusBarEl: StatusBarItemElement;
  private statusText: string = '';
  private tooltipText: string = '';
  private currentStatus: SyncStatus = 'idle';
  private hasActiveSyncCycle: boolean = false;
  private suppressHoverTooltipOnce: boolean = false;
  private tooltipManager = getTooltipManager();
  private lastError?: ErrorDetails;
  private currentProgress?: {
    processedCount: number;
    stats: {
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      deleted: number;
    };
    newContentStats?: {
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      deleted: number;
      total: number;
    };
    bufferZoneStats?: {
      created: number;
      updated: number;
      total: number;
    };
  };

  constructor(plugin: FlomoSyncPlugin) {
    this.plugin = plugin;
    this.statusBarEl = plugin.addStatusBarItem();
    this.registerClickHandler();
    this.updateDisplay();
  }

  /**
   * 注册点击事件处理器（只调用一次）
   */
  private registerClickHandler(): void {
    this.statusBarEl.addEventListener('mousedown', (evt: MouseEvent) => {
      if (evt.button === 0) {
        // 左键 - 根据状态执行不同操作
        if (this.currentStatus === 'error' && this.lastError) {
          // 错误状态 - 显示错误详情
          new ErrorDetailModal(this.plugin.app, this.lastError, this.plugin).open();
        } else {
          // 其他状态 - 快速同步
          void this.plugin.performSync();
        }
      } else if (evt.button === 2) {
        // 右键 - 显示菜单
        evt.preventDefault();
        this.showContextMenu(evt);
      }
    });
    // 阻止默认的 contextmenu 事件（右键菜单）
    this.statusBarEl.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
    });
    this.statusBarEl.addClass('mod-clickable');
    this.statusBarEl.addEventListener('mouseenter', () => {
      if (this.tooltipText) {
        this.tooltipManager.show(this.statusBarEl, this.tooltipText, 100);
      }
    });
    this.statusBarEl.addEventListener('mouseleave', () => {
      this.tooltipManager.hide();
    });
  }

  /**
   * 设置同步状态
   */
  setStatus(status: SyncStatus, message?: string, errorDetails?: Partial<ErrorDetails>): void {
    const previousStatus = this.currentStatus;
    const isLeavingSyncing = previousStatus === 'syncing' && status !== 'syncing';

    if (status === 'syncing') {
      this.hasActiveSyncCycle = true;
      this.suppressHoverTooltipOnce = false;
    }

    this.currentStatus = status;

    if (isLeavingSyncing && this.hasActiveSyncCycle) {
      // 同步结束时主动关闭 tooltip，避免悬停状态下残留
      this.tooltipManager.hide();
      this.suppressHoverTooltipOnce = true;
      this.hasActiveSyncCycle = false;
    }

    switch (status) {
      case 'syncing':
        this.statusText = message || '正在同步...';
        this.statusBarEl.addClass('flomo-sync-active');
        this.lastError = undefined;
        break;
      case 'success':
        this.statusText = message || '同步成功';
        this.statusBarEl.removeClass('flomo-sync-active');
        this.currentProgress = undefined;
        this.lastError = undefined;
        this.updateLastSyncTime();
        break;
      case 'error':
        this.statusText = message || '同步失败';
        this.statusBarEl.removeClass('flomo-sync-active');
        this.currentProgress = undefined;
        // 保存错误详情
        this.lastError = {
          message: message || '同步失败',
          timestamp: Date.now(),
          ...errorDetails,
        };
        break;
      default:
        this.statusBarEl.removeClass('flomo-sync-active');
        this.currentProgress = undefined;
        this.lastError = undefined;
        this.updateLastSyncTime();
        break;
    }

    this.updateDisplay();
  }

  /**
   * 更新实时进度（同步中数字+++效果）
   */
  updateProgress(
    processedCount: number,
    stats: { created: number; updated: number; skipped: number; failed: number; deleted: number },
    newContentStats?: { created: number; updated: number; skipped: number; failed: number; deleted: number; total: number },
    bufferZoneStats?: { created: number; updated: number; total: number }
  ): void {
    this.currentProgress = { processedCount, stats, newContentStats, bufferZoneStats };
    this.updateDisplay();
  }

  /**
   * 更新显示
   */
  private updateDisplay(): void {
    const iconName = this.getStatusIcon();
    this.statusBarEl.empty();

    const container = this.statusBarEl.createSpan({ cls: 'flomo-sync-status' });
    const iconEl = container.createSpan({ cls: 'flomo-sync-icon' });
    setIcon(iconEl, iconName);

    // 同步中且有进度时，显示实时数字
    if (this.currentStatus === 'syncing' && this.currentProgress) {
      const { processedCount, stats, newContentStats } = this.currentProgress;

      // 主数字：大号实时处理数量
      container.createSpan({
        cls: 'flomo-sync-count',
        text: String(processedCount),
      });

      // 简化统计：+5 ~2 ·8（分别代表新增/更新/跳过）
      // 优先显示 B-C 段统计
      const displayStats = newContentStats && newContentStats.total > 0
        ? newContentStats
        : stats;

      const statsEl = container.createSpan({ cls: 'flomo-sync-stats' });
      if (displayStats.created > 0) statsEl.createSpan({ cls: 'stat-created', text: `+${displayStats.created}` });
      if (displayStats.updated > 0) statsEl.createSpan({ cls: 'stat-updated', text: `~${displayStats.updated}` });
      if (displayStats.skipped > 0) statsEl.createSpan({ cls: 'stat-skipped', text: `·${displayStats.skipped}` });
    } else {
      // 非同步状态显示普通文本
      container.createSpan({ text: this.statusText, cls: 'flomo-sync-text' });
    }

    this.updateTooltip();
  }

  /**
   * 更新悬停提示
   */
  private updateTooltip(): void {
    let tooltipText = '';

    switch (this.currentStatus) {
      case 'idle': {
        const lastStats = this.plugin.settings.lastSyncStats;
        if (lastStats && lastStats.timestamp > 0) {
          const syncDate = new Date(lastStats.timestamp).toLocaleString('zh-CN');
          const nc = lastStats.newContent;
          const bz = lastStats.bufferZone;

          if (nc && nc.total > 0) {
            tooltipText = `上次同步：${syncDate}\n`;
            tooltipText += `新增区 +${nc.created} ~${nc.updated} ·${nc.skipped}`;
            if (bz && bz.total > 0) {
              tooltipText += ` | 容错区 +${bz.created} ~${bz.updated}`;
            }
            tooltipText += `\n本次处理 +${lastStats.created} ~${lastStats.updated} ·${lastStats.skipped} ×${lastStats.failed} | ${lastStats.total}条/${lastStats.duration}s`;
          } else {
            tooltipText = `上次同步：${syncDate}\n本次处理 +${lastStats.created} ~${lastStats.updated} ·${lastStats.skipped} ×${lastStats.failed} | ${lastStats.total}条/${lastStats.duration}s`;
          }
        } else {
          tooltipText = 'Flomo 未同步\n点击开始首次同步';
        }
        break;
      }

      case 'syncing': {
        if (this.currentProgress) {
          const { processedCount, stats, newContentStats, bufferZoneStats } = this.currentProgress;

          if (newContentStats && newContentStats.total > 0) {
            tooltipText = `同步中：已处理 ${processedCount} 条\n`;
            tooltipText += `新增区 +${newContentStats.created} ~${newContentStats.updated} ·${newContentStats.skipped}`;
            if (bufferZoneStats && bufferZoneStats.total > 0) {
              tooltipText += ` | 容错区 +${bufferZoneStats.created} ~${bufferZoneStats.updated}`;
            }
            tooltipText += `\n本次处理 +${stats.created} ~${stats.updated} ·${stats.skipped}`;
          } else {
            tooltipText = `同步中：已处理 ${processedCount} 条\n本次处理 +${stats.created} ~${stats.updated} ·${stats.skipped}`;
          }
        } else {
          tooltipText = '同步中...';
        }
        break;
      }

      case 'success': {
        const lastStats = this.plugin.settings.lastSyncStats;
        if (lastStats) {
          const nc = lastStats.newContent;
          if (nc && nc.total > 0) {
            tooltipText = `同步完成\n新增区 +${nc.created} ~${nc.updated} ·${nc.skipped}\n点击查看详情`;
          } else {
            tooltipText = `同步完成\n本次处理 +${lastStats.created} ~${lastStats.updated} ·${lastStats.skipped} ×${lastStats.failed}\n点击查看详情`;
          }
        } else {
          tooltipText = '同步完成\n点击查看详情';
        }
        break;
      }

      case 'error': {
        if (this.lastError) {
          const shortErrorMessage = this.lastError.message.length > 36
            ? `${this.lastError.message.slice(0, 36)}...`
            : this.lastError.message;
          tooltipText = `同步失败：${shortErrorMessage}\n点击查看详情并重试`;
        } else {
          tooltipText = '同步失败\n点击查看详情并重试';
        }
        break;
      }
    }

    this.tooltipText = tooltipText;
    if (this.statusBarEl.matches(':hover') && this.tooltipText) {
      if (this.suppressHoverTooltipOnce) {
        this.suppressHoverTooltipOnce = false;
        return;
      }
      this.tooltipManager.show(this.statusBarEl, this.tooltipText, 100);
    }
  }

  /**
   * 获取状态图标 (Lucide 图标名称)
   */
  private getStatusIcon(): string {
    switch (this.currentStatus) {
      case 'syncing':
        return 'loader';
      case 'success':
        return 'check-circle';
      case 'error':
        return 'alert-circle';
      default:
        return 'cloud';
    }
  }

  /**
   * 更新上次同步时间显示
   */
  private updateLastSyncTime(): void {
    const lastStats = this.plugin.settings.lastSyncStats;
    if (lastStats && lastStats.timestamp > 0) {
      const lastSync = moment(lastStats.timestamp);
      const now = moment();
      const diffMinutes = now.diff(lastSync, 'minutes');
      const diffHours = now.diff(lastSync, 'hours');
      const diffDays = now.diff(lastSync, 'days');

      let timeText: string;
      if (diffMinutes < 1) {
        timeText = '刚刚';
      } else if (diffMinutes < 60) {
        timeText = `${diffMinutes}分钟前`;
      } else if (diffHours < 24) {
        timeText = `${diffHours}小时前`;
      } else {
        timeText = `${diffDays}天前`;
      }

      this.statusText = `Flomo: ${timeText}`;
    } else {
      this.statusText = 'Flomo: 未同步';
    }
  }

  /**
   * 显示进度通知
   */
  showProgressNotice(message: string): void {
    // 可选：使用 Obsidian Notice 显示进度
    // 注意：频繁更新 Notice 可能影响性能，建议只在重要节点显示
  }

  /**
   * 清理资源
   */
  unload(): void {
    this.tooltipManager.hide();
    this.statusBarEl.remove();
  }

  /**
   * 显示右键上下文菜单
   */
  private showContextMenu(evt: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle('立即同步')
        .setIcon('sync')
        .onClick(() => {
          void this.plugin.performSync();
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('全量同步')
        .setIcon('refresh-cw')
        .onClick(() => {
          void this.plugin.performFullSync();
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('打开设置')
        .setIcon('settings')
        .onClick(() => {
          this.plugin.openSettings();
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('上次同步详情...')
        .setIcon('info')
        .onClick(() => {
          this.showLastSyncDetails();
        })
    );

    menu.showAtMouseEvent(evt);
  }

  /**
   * 显示上次同步详情
   */
  private showLastSyncDetails(): void {
    const lastStats = this.plugin.settings.lastSyncStats;
    if (lastStats) {
      const syncDate = new Date(lastStats.timestamp).toLocaleString('zh-CN');
      const nc = lastStats.newContent;
      const bz = lastStats.bufferZone;

      let message = `上次同步统计 (${syncDate})\n`;

      if (nc && nc.total > 0) {
        message += `【真正新增】新增: ${nc.created} | 更新: ${nc.updated} | 跳过: ${nc.skipped}\n`;
      }
      if (bz && bz.total > 0) {
        message += `【容错区变化】新增: ${bz.created} | 更新: ${bz.updated}\n`;
      }
      message += `【实际处理】新增: ${lastStats.created} | 更新: ${lastStats.updated} | 跳过: ${lastStats.skipped} | 失败: ${lastStats.failed}\n`;
      message += `总计: ${lastStats.total} 条 | 耗时: ${lastStats.duration}秒`;

      new Notice(message, 6000);
    } else {
      new Notice('暂无同步记录', 3000);
    }
  }
}

/**
 * 添加 CSS 样式（样式已迁移至 styles.css）
 */
export function addStatusBarStyles(_plugin: Plugin): void {
  // 样式由 Obsidian 自动从 styles.css 加载
}
