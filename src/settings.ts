/**
 * 插件设置管理
 *
 * 持久化配置到 Obsidian 的 data.json
 * 设置界面采用 Tab 导航 + 卡片式布局
 */

import { PluginSettingTab, Setting, App, Notice, setIcon } from 'obsidian';
import type FlomoSyncPlugin from '../main';
import type { LastSyncStats } from './types';
import { FlomoClient, FlomoApiError } from './flomoClient';
import { getTooltipManager } from './tooltip';
import { SETUP_GIF_BASE64 } from './setupGifBase64';

/** 默认设置 */
export const DEFAULT_SETTINGS: FlomoSyncSettings = {
  token: '',
  targetDir: 'flomo',
  downloadAttachments: true,
  syncInterval: 60,
  debugMode: false,
  // 游标数据（内部使用）
  cursor: {
    latest_updated_at: 0,
    latest_slug: '',
  },
  // 上次同步统计
  lastSyncStats: undefined,
  // 反向链接设置
  enableBacklinks: true,
  backlinkLinkStyle: 'wikilink',
};

/** 插件设置接口 */
export interface FlomoSyncSettings {
  /** flomo access token */
  token: string;
  /** 同步目标目录 */
  targetDir: string;
  /** 是否下载附件 */
  downloadAttachments: boolean;
  /** 自动同步间隔（秒），0 表示禁用 */
  syncInterval: number;
  /** 调试模式 */
  debugMode: boolean;
  /** 同步游标（内部状态） */
  cursor: {
    latest_updated_at: number;
    latest_slug: string;
  };
  /** 上次同步统计 */
  lastSyncStats?: LastSyncStats;
  /** Token 是否已验证 */
  tokenValidated?: boolean;
  /** Token 验证时间戳 */
  tokenValidatedAt?: number;
  /** 是否启用反向链接转换 */
  enableBacklinks?: boolean;
  /** 反向链接格式：wikilink 或 markdown */
  backlinkLinkStyle?: 'wikilink' | 'markdown';
}

/** Tab 定义 */
interface TabDefinition {
  id: string;
  label: string;
  icon: string;
}

/** 设置面板 */
export class FlomoSyncSettingTab extends PluginSettingTab {
  plugin: FlomoSyncPlugin;
  private static readonly HEATMAP_WEEKS = 53;

  private readonly tabs: TabDefinition[] = [
    { id: 'overview', label: '概览', icon: 'layout-dashboard' },
    { id: 'config', label: '配置', icon: 'settings' },
    { id: 'actions', label: '操作', icon: 'zap' },
  ];

  private currentTab: string = 'overview';
  private contentContainer: HTMLElement | null = null;

  constructor(app: App, plugin: FlomoSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 添加设置面板样式
    this.addSettingsStyles(containerEl);

    // 标题
    new Setting(containerEl).setName('Flomo Bridge 设置').setHeading();

    // 渲染 Tab 导航
    this.renderTabNav(containerEl);

    // 创建内容容器
    this.contentContainer = containerEl.createDiv({ cls: 'flomo-tab-content' });

    // 渲染当前 Tab 内容
    this.renderCurrentTab();
  }

  /**
   * 添加设置面板样式（样式已迁移至 styles.css）
   */
  private addSettingsStyles(containerEl: HTMLElement): void {
    containerEl.addClass('flomo-settings-container');
  }

  /**
   * 渲染 Tab 导航
   */
  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: 'flomo-tab-nav' });

    for (const tab of this.tabs) {
      const button = nav.createEl('button', {
        cls: `flomo-tab-button${tab.id === this.currentTab ? ' active' : ''}`,
      });

      // 图标
      const iconSpan = button.createSpan({ cls: 'flomo-tab-icon' });
      setIcon(iconSpan, tab.icon);

      // 标签
      button.createSpan({ text: tab.label });

      // 点击事件
      button.addEventListener('click', () => {
        this.switchTab(tab.id);
      });
    }
  }

  /**
   * 切换 Tab
   */
  private switchTab(tabId: string): void {
    if (tabId === this.currentTab) return;

    this.currentTab = tabId;

    // 更新 Tab 按钮状态
    const buttons = this.containerEl.querySelectorAll('.flomo-tab-button');
    buttons.forEach((btn, index) => {
      if (this.tabs[index]?.id === tabId) {
        btn.addClass('active');
      } else {
        btn.removeClass('active');
      }
    });

    // 重新渲染内容
    this.renderCurrentTab();
  }

  /**
   * 渲染当前 Tab 内容
   */
  private renderCurrentTab(): void {
    if (!this.contentContainer) return;

    this.contentContainer.empty();

    switch (this.currentTab) {
      case 'overview':
        this.renderOverviewTab(this.contentContainer);
        break;
      case 'config':
        this.renderConfigTab(this.contentContainer);
        break;
      case 'actions':
        this.renderActionTab(this.contentContainer);
        break;
    }
  }

  /**
   * 渲染概览 Tab
   */
  private renderOverviewTab(container: HTMLElement): void {
    const lastStats = this.plugin.settings.lastSyncStats;
    const cursor = this.plugin.settings.cursor;
    const hasSyncHistory = cursor.latest_updated_at > 0;

    if (!hasSyncHistory) {
      // 首次使用引导
      const emptyState = container.createDiv({ cls: 'flomo-empty-state' });
      const iconEl = emptyState.createDiv({ cls: 'flomo-empty-state-icon' });
      setIcon(iconEl, 'cloud');
      emptyState.createDiv({
        cls: 'flomo-empty-state-text',
        text: '欢迎使用 Flomo Bridge！请先在「配置」Tab 设置 Token，然后在「操作」Tab 开始同步。',
      });
      return;
    }

    // 状态卡片组
    const statusCard = container.createDiv({ cls: 'flomo-settings-card' });
    const statusHeader = statusCard.createDiv({ cls: 'flomo-settings-card-header' });
    statusHeader.createEl('h3', { text: '同步状态' });

    const statusGrid = statusCard.createDiv({ cls: 'flomo-status-grid' });

    // 连接状态 - 三种状态：未配置、待验证、已连接
    const hasToken = !!this.plugin.settings.token;
    const isValidated = this.plugin.settings.tokenValidated;

    let connectionStatusClass: string;
    let connectionIconName: string;
    let connectionText: string;

    if (!hasToken) {
      // 无 Token - 未配置
      connectionStatusClass = 'status-disconnected';
      connectionIconName = 'unlink';
      connectionText = '未配置';
    } else if (!isValidated) {
      // 有 Token 未验证 - 待验证
      connectionStatusClass = 'status-pending';
      connectionIconName = 'link';
      connectionText = '待验证';
    } else {
      // 有 Token 已验证 - 已连接
      connectionStatusClass = 'status-connected';
      connectionIconName = 'link';
      connectionText = '已连接';
    }

    const connectionCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    connectionCard.createDiv({ cls: 'flomo-status-card-title', text: '连接状态' });
    const connectionValue = connectionCard.createDiv({
      cls: `flomo-status-card-value ${connectionStatusClass}`,
    });
    const connectionIcon = connectionValue.createSpan({ cls: 'status-icon' });
    setIcon(connectionIcon, connectionIconName);
    connectionValue.appendText(connectionText);

    // 同步状态
    const syncCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    syncCard.createDiv({ cls: 'flomo-status-card-title', text: '同步状态' });
    const isSyncing = this.plugin.isSyncing;
    const syncValue = syncCard.createDiv({
      cls: `flomo-status-card-value ${isSyncing ? 'status-syncing' : lastStats && lastStats.failed > 0 ? 'status-error' : 'status-connected'}`,
    });
    const syncIcon = syncValue.createSpan({ cls: 'status-icon' });
    if (isSyncing) {
      setIcon(syncIcon, 'loader');
    } else if (lastStats && lastStats.failed > 0) {
      setIcon(syncIcon, 'alert-circle');
    } else {
      setIcon(syncIcon, 'check-circle');
    }
    syncValue.appendText(isSyncing ? '同步中' : lastStats && lastStats.failed > 0 ? '有错误' : '正常');

    // 总记录数
    const totalCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    totalCard.createDiv({ cls: 'flomo-status-card-title', text: '本地记录' });
    const totalValue = totalCard.createDiv({ cls: 'flomo-status-card-value' });
    const totalCount = this.getLocalMemoCount();
    totalValue.appendText(String(totalCount));

    // 上次同步时间
    const lastSyncCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    lastSyncCard.createDiv({ cls: 'flomo-status-card-title', text: '上次同步' });
    const lastSyncValue = lastSyncCard.createDiv({ cls: 'flomo-status-card-value' });
    const lastSyncTime = lastStats?.timestamp
      ? this.getRelativeTime(Math.floor(lastStats.timestamp / 1000))
      : '从未同步';
    lastSyncValue.appendText(lastSyncTime);

    // 同步历史统计卡片（从原 renderDataTab 移入）
    if (lastStats) {
      const statsCard = container.createDiv({ cls: 'flomo-settings-card' });
      const statsHeader = statsCard.createDiv({ cls: 'flomo-settings-card-header' });
      const statsIcon = statsHeader.createSpan();
      setIcon(statsIcon, 'pie-chart');

      const hasNewContentStats = lastStats.newContent && lastStats.newContent.total > 0;
      statsHeader.createEl('h3', {
        text: hasNewContentStats ? '上次同步统计（真正新增）' : '上次同步统计'
      });

      const statsGrid = statsCard.createDiv({ cls: 'flomo-stats-grid-detailed' });

      // 决定显示哪套统计
      const displayStats = hasNewContentStats ? lastStats.newContent! : lastStats;

      // 新增
      const createdCard = statsGrid.createDiv({ cls: 'flomo-stats-card created' });
      createdCard.createDiv({ cls: 'flomo-stats-card-value', text: String(displayStats.created) });
      createdCard.createDiv({ cls: 'flomo-stats-card-label', text: '新增' });

      // 更新
      const updatedCard = statsGrid.createDiv({ cls: 'flomo-stats-card updated' });
      updatedCard.createDiv({ cls: 'flomo-stats-card-value', text: String(displayStats.updated) });
      updatedCard.createDiv({ cls: 'flomo-stats-card-label', text: '更新' });

      // 跳过（只在实际处理统计或 B-C 段统计中显示）
      const skippedCard = statsGrid.createDiv({ cls: 'flomo-stats-card skipped' });
      skippedCard.createDiv({ cls: 'flomo-stats-card-value', text: String(displayStats.skipped) });
      skippedCard.createDiv({ cls: 'flomo-stats-card-label', text: '跳过' });

      // 失败（只在实际处理统计中显示）
      const failedCard = statsGrid.createDiv({ cls: 'flomo-stats-card failed' });
      failedCard.createDiv({ cls: 'flomo-stats-card-value', text: String(lastStats.failed) });
      failedCard.createDiv({ cls: 'flomo-stats-card-label', text: '失败' });

      // 详细信息
      statsCard.createDiv({
        cls: 'flomo-stats-footer',
        text: `总计: ${lastStats.total} 条 | 耗时: ${lastStats.duration}秒 | ${new Date(lastStats.timestamp).toLocaleString('zh-CN')}`,
      });

      // 如果有两套统计，添加说明
      if (hasNewContentStats) {
        const bz = lastStats.bufferZone;
        let noteText = `* 实际处理了 ${lastStats.created} 新增 / ${lastStats.updated} 更新（含容错缓冲区内容）`;
        if (bz && bz.total > 0) {
          noteText += `，其中容错区有 ${bz.created} 新增 / ${bz.updated} 更新`;
        }
        statsCard.createDiv({ cls: 'flomo-stats-note', text: noteText });
      }
    }

    // 完整热力图（从原 renderDataTab 移入）
    this.renderContributionHeatmap(container);
  }

  /**
   * 渲染配置 Tab
   */
  private renderConfigTab(container: HTMLElement): void {
    // 连接配置卡片
    const connectionCard = container.createDiv({ cls: 'flomo-settings-card' });
    const connectionHeader = connectionCard.createDiv({ cls: 'flomo-settings-card-header' });
    const connectionIcon = connectionHeader.createSpan();
    setIcon(connectionIcon, 'link');
    connectionHeader.createEl('h3', { text: '连接配置' });

    // Token 设置
    new Setting(connectionCard)
      .setName('Flomo Token')
      .setDesc('用于访问 flomo API，可直接粘贴 Authorization 中的 token。')
      .addText((text) =>
        text
          .setPlaceholder('Bearer 1023456|... 或直接粘贴 token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            // 自动去除 Bearer 前缀
            let token = value.trim();
            if (token.toLowerCase().startsWith('bearer ')) {
              token = token.slice(7).trim();
            }

            // Token 变化时重置验证状态
            if (token !== this.plugin.settings.token) {
              this.plugin.settings.tokenValidated = false;
            }

            this.plugin.settings.token = token;
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) => {
        button
          .setButtonText('验证')
          .onClick(async () => {
            await this.validateToken(button);
          });
      });

    // Token 获取帮助与示意图（独立于 Setting 描述区，避免与输入区并排）
    const tokenHelpBlock = connectionCard.createDiv({ cls: 'flomo-token-help-block' });
    const tokenSteps = tokenHelpBlock.createDiv({ cls: 'flomo-token-help-steps' });
    tokenSteps.appendText('步骤：');
    tokenSteps.createEl('br');
    tokenSteps.appendText('1. 点击 ');
    tokenSteps.createEl('a', {
      text: 'v.flomoapp.com/mine',
      href: 'https://v.flomoapp.com/mine',
      attr: { target: '_blank' },
    });
    tokenSteps.appendText(' 登录 flomo');
    tokenSteps.createEl('br');
    tokenSteps.appendText('2. 按 F12 → Network → 找到 api 请求 → 复制 Authorization 中的 token');

    const demoCollapsible = tokenHelpBlock.createDiv({
      cls: 'flomo-config-collapsible flomo-token-demo-collapsible',
    });
    const demoHeader = demoCollapsible.createDiv({ cls: 'flomo-config-collapsible-header' });
    demoHeader.setAttr('role', 'button');
    demoHeader.setAttr('tabindex', '0');
    demoHeader.setAttr('aria-expanded', 'false');
    const headerLabel = demoHeader.createDiv({ cls: 'flomo-token-demo-header-label' });
    const chevron = headerLabel.createSpan({ cls: 'flomo-token-demo-chevron' });
    setIcon(chevron, 'chevron-right');
    headerLabel.createSpan({ text: 'Token 获取示意图' });

    const demoContent = demoCollapsible.createDiv({
      cls: 'flomo-config-collapsible-content flomo-token-demo-content hidden',
    });
    const imageWrap = demoContent.createDiv({ cls: 'flomo-token-demo-image-wrap' });
    imageWrap.createEl('img', {
      cls: 'flomo-token-demo-image',
      attr: {
        src: SETUP_GIF_BASE64,
        alt: 'Token 获取示意图',
      },
    });

    const toggleDemo = () => {
      const isHidden = demoContent.hasClass('hidden');
      if (isHidden) {
        demoContent.removeClass('hidden');
        demoCollapsible.addClass('is-open');
        demoHeader.setAttr('aria-expanded', 'true');
      } else {
        demoContent.addClass('hidden');
        demoCollapsible.removeClass('is-open');
        demoHeader.setAttr('aria-expanded', 'false');
      }
    };

    demoHeader.addEventListener('click', toggleDemo);
    demoHeader.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        toggleDemo();
      }
    });

    // 同步配置卡片
    const syncCard = container.createDiv({ cls: 'flomo-settings-card' });
    const syncHeader = syncCard.createDiv({ cls: 'flomo-settings-card-header' });
    const syncIcon = syncHeader.createSpan();
    setIcon(syncIcon, 'folder-sync');
    syncHeader.createEl('h3', { text: '同步配置' });

    // 目标目录
    const targetDirSetting = new Setting(syncCard)
      .setName('同步目标目录')
      .setDesc('相对于 Vault 根目录的路径，flomo 笔记将同步到此目录')
      .addText((text) =>
        text
          .setPlaceholder('flomo')
          .setValue(this.plugin.settings.targetDir)
          .onChange(async (value) => {
            const newValue = value.trim() || 'flomo';
            this.plugin.settings.targetDir = newValue;
            await this.plugin.saveSettings();
            // 更新完整路径显示
            this.updateFullPathDisplay(fullPathEl, newValue);
          })
      );

    // 添加完整路径显示
    const fullPathContainer = targetDirSetting.descEl.createDiv({ cls: 'flomo-full-path-container' });
    fullPathContainer.createSpan({ text: '完整路径: ', cls: 'flomo-full-path-label' });
    const fullPathEl = fullPathContainer.createSpan({ cls: 'flomo-full-path-value' });
    this.updateFullPathDisplay(fullPathEl, this.plugin.settings.targetDir);

    // 附件下载
    new Setting(syncCard)
      .setName('下载附件')
      .setDesc('是否下载图片和音频附件到本地（推荐开启）')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.downloadAttachments)
          .onChange(async (value) => {
            this.plugin.settings.downloadAttachments = value;
            await this.plugin.saveSettings();
          })
      );

    // 自动同步间隔
    new Setting(syncCard)
      .setName('自动同步间隔')
      .setDesc('设置为"手动同步"则关闭自动同步，默认每隔1分钟同步')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('0', '手动同步')
          .addOption('10', '10秒')
          .addOption('30', '30秒')
          .addOption('60', '1分钟')
          .addOption('300', '5分钟')
          .addOption('600', '10分钟')
          .addOption('1800', '30分钟')
          .addOption('3600', '1小时')
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async (value) => {
            const interval = parseInt(value, 10);
            this.plugin.settings.syncInterval = interval;
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          })
      );

    // 反向链接设置卡片
    const backlinkCard = container.createDiv({ cls: 'flomo-settings-card' });
    const backlinkHeader = backlinkCard.createDiv({ cls: 'flomo-settings-card-header' });
    const backlinkIcon = backlinkHeader.createSpan();
    setIcon(backlinkIcon, 'link');
    backlinkHeader.createEl('h3', { text: '反向链接' });

    // 启用反向链接转换
    new Setting(backlinkCard)
      .setName('启用反向链接转换')
      .setDesc('将 flomo memo 互相引用的外部链接自动转换为 Obsidian 反向链接')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBacklinks ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableBacklinks = value;
            await this.plugin.saveSettings();
            this.renderCurrentTab();
          })
      );


    // 开发者选项卡片（默认折叠）
    const devCard = container.createDiv({ cls: 'flomo-settings-card' });
    const devHeader = devCard.createDiv({ cls: 'flomo-settings-card-header' });
    const devIcon = devHeader.createSpan();
    setIcon(devIcon, 'code');
    devHeader.createEl('h3', { text: '开发者选项' });

    // 调试模式
    new Setting(devCard)
      .setName('调试模式')
      .setDesc('在控制台输出详细日志（用于排查问题）')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
          })
      );
  }

  /**
   * 渲染操作 Tab
   */
  private renderActionTab(container: HTMLElement): void {
    // 常规操作卡片
    const actionCard = container.createDiv({ cls: 'flomo-settings-card' });
    const actionHeader = actionCard.createDiv({ cls: 'flomo-settings-card-header' });
    const actionIcon = actionHeader.createSpan();
    setIcon(actionIcon, 'zap');
    actionHeader.createEl('h3', { text: '同步操作' });

    const buttonsContainer = actionCard.createDiv({ cls: 'flomo-action-buttons' });

    // 立即同步
    const syncRow = buttonsContainer.createDiv({ cls: 'flomo-action-row' });
    const syncInfo = syncRow.createDiv({ cls: 'flomo-action-info' });
    syncInfo.createEl('h4', { text: '立即同步' });
    syncInfo.createEl('p', { text: '执行增量同步，只获取新增和更新的内容' });

    const syncButton = syncRow.createEl('button', {
      text: this.plugin.isSyncing ? '同步中...' : '开始同步',
      cls: 'mod-cta',
    });
    syncButton.disabled = this.plugin.isSyncing;
    syncButton.addEventListener('click', () => {
      syncButton.disabled = true;
      syncButton.textContent = '同步中...';
      this.plugin.performSync().finally(() => {
        syncButton.disabled = this.plugin.isSyncing;
        syncButton.textContent = this.plugin.isSyncing ? '同步中...' : '开始同步';
        this.renderCurrentTab();
      });
    });

    // 全量同步
    const fullSyncRow = buttonsContainer.createDiv({ cls: 'flomo-action-row' });
    const fullSyncInfo = fullSyncRow.createDiv({ cls: 'flomo-action-info' });
    fullSyncInfo.createEl('h4', { text: '全量同步' });
    fullSyncInfo.createEl('p', { text: '重置游标并重新同步所有笔记（会更新已存在的文件）' });

    const fullSyncButton = fullSyncRow.createEl('button', {
      text: this.plugin.isSyncing ? '同步中...' : '全量同步',
    });
    fullSyncButton.disabled = this.plugin.isSyncing;
    fullSyncButton.addEventListener('click', () => {
      fullSyncButton.disabled = true;
      fullSyncButton.textContent = '同步中...';
      this.plugin.performFullSync().finally(() => {
        fullSyncButton.disabled = this.plugin.isSyncing;
        fullSyncButton.textContent = this.plugin.isSyncing ? '同步中...' : '全量同步';
        this.renderCurrentTab();
      });
    });

    // 修复卡片
    const repairCard = container.createDiv({ cls: 'flomo-settings-card' });
    const repairHeader = repairCard.createDiv({ cls: 'flomo-settings-card-header' });
    const repairIcon = repairHeader.createSpan();
    setIcon(repairIcon, 'refresh-cw');
    repairHeader.createEl('h3', { text: '修复' });

    const repairButtonsContainer = repairCard.createDiv({ cls: 'flomo-action-buttons' });
    const repairRow = repairButtonsContainer.createDiv({ cls: 'flomo-action-row' });
    const repairInfo = repairRow.createDiv({ cls: 'flomo-action-info' });
    repairInfo.createEl('h4', { text: '修复' });
    repairInfo.createEl('p', { text: '将 flomo 链接替换为 Obsidian 反向链接，并删除本地已被服务端移除的文件' });

    const repairButton = repairRow.createEl('button', {
      text: this.plugin.isSyncing ? '修复中...' : '开始修复',
    });
    repairButton.disabled = this.plugin.isSyncing;
    repairButton.addEventListener('click', () => {
      repairButton.disabled = true;
      repairButton.textContent = '修复中...';
      this.plugin.performRepairAndCleanup().finally(() => {
        repairButton.disabled = this.plugin.isSyncing;
        repairButton.textContent = this.plugin.isSyncing ? '修复中...' : '开始修复';
        this.renderCurrentTab();
      });
    });

    // 危险操作卡片
    const dangerCard = container.createDiv({ cls: 'flomo-settings-card danger' });
    const dangerHeader = dangerCard.createDiv({ cls: 'flomo-settings-card-header' });
    const dangerIcon = dangerHeader.createSpan();
    setIcon(dangerIcon, 'alert-triangle');
    dangerHeader.createEl('h3', { text: '危险区域' });

    // 重置同步状态
    new Setting(dangerCard)
      .setName('重置同步状态')
      .setDesc('清除同步游标，下次同步将从头开始（不会删除本地文件）')
      .addButton((button) =>
        button
          .setButtonText('重置')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.cursor = { latest_updated_at: 0, latest_slug: '' };
            await this.plugin.saveSettings();
            new Notice('同步状态已重置，下次将执行全量同步');
            this.renderCurrentTab();
          })
      );

    // 清除本地数据
    new Setting(dangerCard)
      .setName('清除本地数据')
      .setDesc('删除同步目录中的所有 flomo 笔记文件（此操作不可恢复）')
      .addButton((button) =>
        button
          .setButtonText('清除')
          .setWarning()
          .onClick(async () => {
            await this.clearLocalData();
          })
      );
  }

  /**
   * 清除本地数据
   */
  private async clearLocalData(): Promise<void> {
    try {
      const dir = this.normalizeTargetDir(this.plugin.settings.targetDir);
      const folder = this.app.vault.getAbstractFileByPath(dir);

      if (!folder) {
        new Notice('同步目录不存在');
        return;
      }

      // 删除目录下的所有文件
      const files = this.app.vault.getMarkdownFiles().filter(f =>
        f.path.startsWith(dir + '/')
      );

      for (const file of files) {
        await this.app.vault.delete(file);
      }

      new Notice('本地数据已清除');
    } catch (error) {
      new Notice('清除失败: ' + (error as Error).message);
    }
  }

  /**
   * 渲染贡献热力图
   */
  private renderContributionHeatmap(containerEl: HTMLElement): void {
    const tooltipManager = getTooltipManager();
    const heatmapCard = containerEl.createDiv({ cls: 'flomo-settings-card' });
    const heatmapHeader = heatmapCard.createDiv({ cls: 'flomo-settings-card-header' });
    const heatmapIcon = heatmapHeader.createSpan();
    setIcon(heatmapIcon, 'calendar');
    heatmapHeader.createEl('h3', { text: '记录活跃度（最近一年）' });

    // 添加统计信息到标题行右侧
    const dailyCounts = this.collectDailyMemoCounts();
    const totalCount = this.getLocalMemoCount();
    const lastYearCount = this.calculateLastYearCount(dailyCounts);
    const statsEl = heatmapHeader.createDiv({ cls: 'flomo-heatmap-header-stats' });
    statsEl.createSpan({ text: `最近一年: ${lastYearCount} 条`, cls: 'flomo-heatmap-stat-item' });
    statsEl.createSpan({ text: ' | ', cls: 'flomo-heatmap-stat-separator' });
    statsEl.createSpan({ text: `总计: ${totalCount} 条`, cls: 'flomo-heatmap-stat-item' });

    const heatmapContainer = heatmapCard.createDiv({ cls: 'flomo-heatmap-container' });
    const maxCount = Math.max(...dailyCounts.values(), 0);

    if (maxCount === 0) {
      heatmapContainer.createDiv({
        cls: 'flomo-heatmap-empty',
        text: '暂无同步数据，完成同步后会展示每日记录热力图。',
      });
      return;
    }

    const weeks = FlomoSyncSettingTab.HEATMAP_WEEKS;
    const today = this.startOfDay(new Date());
    const currentWeekStart = this.getWeekStart(today);
    const startDate = new Date(currentWeekStart);
    startDate.setDate(startDate.getDate() - (weeks - 1) * 7);

    const monthsRow = heatmapContainer.createDiv({ cls: 'flomo-heatmap-months' });
    const monthGrid = monthsRow.createDiv({ cls: 'flomo-heatmap-month-grid' });
    let previousMonth = -1;
    for (let week = 0; week < weeks; week++) {
      const weekStart = new Date(startDate);
      weekStart.setDate(startDate.getDate() + week * 7);
      const monthCell = monthGrid.createDiv({ cls: 'flomo-heatmap-month-cell' });
      if (weekStart.getMonth() !== previousMonth) {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        monthCell.setText(monthNames[weekStart.getMonth()]);
      }
      previousMonth = weekStart.getMonth();
    }

    const body = heatmapContainer.createDiv({ cls: 'flomo-heatmap-body' });
    const grid = body.createDiv({ cls: 'flomo-heatmap-grid' });
    for (let week = 0; week < weeks; week++) {
      const weekColumn = grid.createDiv({ cls: 'flomo-heatmap-week' });
      for (let day = 0; day < 7; day++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + week * 7 + day);
        const dateKey = this.formatDateKey(date);
        const count = dailyCounts.get(dateKey) ?? 0;
        const level = this.resolveHeatmapLevel(count);
        const tooltipText = `${dateKey}: ${count} 条`;
        const cell = weekColumn.createDiv({ cls: `flomo-heatmap-cell flomo-heatmap-level-${level}` });
        cell.setAttr('aria-description', tooltipText);
        cell.setAttr('tabindex', '0');
        cell.addEventListener('mouseenter', () => tooltipManager.show(cell, tooltipText, 100));
        cell.addEventListener('mouseleave', () => tooltipManager.hide());
        cell.addEventListener('focus', () => tooltipManager.show(cell, tooltipText, 100));
        cell.addEventListener('blur', () => tooltipManager.hide());
      }
    }

    const legend = heatmapContainer.createDiv({ cls: 'flomo-heatmap-legend' });
    legend.createSpan({ cls: 'flomo-heatmap-legend-text', text: '少' });
    const legendLevels = [0, 1, 3, 5, 7, 9];
    for (const level of legendLevels) {
      legend.createDiv({ cls: `flomo-heatmap-cell flomo-heatmap-level-${level}` });
    }
    legend.createSpan({ cls: 'flomo-heatmap-legend-text', text: '多' });
  }

  /**
   * 聚合目标目录下 memo 的每日数量
   */
  private collectDailyMemoCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const dir = this.normalizeTargetDir(this.plugin.settings.targetDir);
    const markdownFiles = this.app.vault.getMarkdownFiles();

    for (const file of markdownFiles) {
      if (dir && !(file.path === dir || file.path.startsWith(`${dir}/`))) {
        continue;
      }
      if (file.path.includes('/attachments/')) {
        continue;
      }

      const dateMatch = file.name.match(/^(\d{4}-\d{2}-\d{2})_/);
      if (!dateMatch) {
        continue;
      }

      const dateKey = dateMatch[1];
      counts.set(dateKey, (counts.get(dateKey) ?? 0) + 1);
    }

    return counts;
  }

  /**
   * 路径归一化
   */
  private normalizeTargetDir(dir: string): string {
    const trimmed = dir.trim();
    if (!trimmed || trimmed === '.') {
      return '';
    }
    return trimmed.replace(/^\.?\//, '').replace(/\/+$/, '');
  }

  /**
   * 更新完整路径显示
   */
  private updateFullPathDisplay(element: HTMLElement, targetDir: string): void {
    const normalizedDir = this.normalizeTargetDir(targetDir) || 'flomo';
    const vaultPath = this.app.vault.getName();
    element.textContent = `${vaultPath}/${normalizedDir}`;
  }

  /**
   * 使用 log 函数计算热力图色阶 (0-9)
   * 映射关系: 0->0, 1->1, 2->2, 3->3, 4->4, 5-6->5, 7-8->6, 9-12->7, 13-15->8, 16+->9
   */
  private resolveHeatmapLevel(count: number): number {
    if (count <= 0) return 0;
    // 映射数组: index 为 count, value 为 level
    const levels = [0, 1, 2, 3, 4, 5, 5, 6, 6, 7, 7, 7, 7, 8, 8, 8, 9];
    return count < levels.length ? levels[count] : 9;
  }

  /**
   * 获取当天的 0 点时间
   */
  private startOfDay(date: Date): Date {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    return normalized;
  }

  /**
   * 获取所在周的周日
   */
  private getWeekStart(date: Date): Date {
    const start = this.startOfDay(date);
    start.setDate(start.getDate() - start.getDay());
    return start;
  }

  /**
   * 格式化为 YYYY-MM-DD
   */
  private formatDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * 计算最近一年的记录数
   */
  private calculateLastYearCount(dailyCounts: Map<string, number>): number {
    const today = this.startOfDay(new Date());
    const oneYearAgo = new Date(today);
    oneYearAgo.setDate(oneYearAgo.getDate() - 365);

    let count = 0;
    for (const [dateKey, dayCount] of dailyCounts.entries()) {
      const date = new Date(dateKey);
      if (date >= oneYearAgo && date <= today) {
        count += dayCount;
      }
    }
    return count;
  }

  /**
   * 获取本地记录数
   */
  private getLocalMemoCount(): number {
    const dir = this.normalizeTargetDir(this.plugin.settings.targetDir);
    return this.app.vault.getMarkdownFiles().filter(f => {
      if (dir && !(f.path === dir || f.path.startsWith(`${dir}/`))) {
        return false;
      }
      return !f.path.includes('/attachments/');
    }).length;
  }

  /**
   * 获取相对时间字符串
   */
  private getRelativeTime(timestamp: number): string {
    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
    return new Date(timestamp * 1000).toLocaleDateString('zh-CN');
  }

  /**
   * 刷新设置界面（在同步完成后调用）
   */
  refresh(): void {
    if (!this.contentContainer) return;
    this.renderCurrentTab();
  }

  /**
   * 验证 Token 有效性
   */
  private async validateToken(button: import('obsidian').ButtonComponent): Promise<void> {
    const token = this.plugin.settings.token;
    if (!token) {
      new Notice('请先输入 Token');
      return;
    }

    const originalText = button.buttonEl.getText();
    button.setButtonText('验证中...');
    button.setDisabled(true);

    try {
      const client = new FlomoClient({
        token: token,
        targetDir: this.plugin.settings.targetDir,
        downloadAttachments: this.plugin.settings.downloadAttachments,
        syncInterval: this.plugin.settings.syncInterval,
        debugMode: this.plugin.settings.debugMode,
      });

      await client.fetchMemosPage(0, '');

      // 验证成功，更新验证状态
      this.plugin.settings.tokenValidated = true;
      this.plugin.settings.tokenValidatedAt = Date.now();
      await this.plugin.saveSettings();

      // 刷新概览页面显示
      if (this.currentTab === 'overview') {
        this.renderCurrentTab();
      }

      new Notice('✅ Token 有效', 3000);
    } catch (error) {
      this.plugin.log('Token validation error:', error);

      let errorMsg = '验证失败';
      if (error instanceof FlomoApiError) {
        if (error.status === 401 || error.message.includes('登录') || error.message.includes('token')) {
          errorMsg = 'Token 无效或已过期';
        } else if (error.status === 0) {
          errorMsg = '网络连接失败';
        } else {
          errorMsg = error.message;
        }
      } else {
        errorMsg = (error as Error).message || '未知错误';
      }

      new Notice(`❌ ${errorMsg}`, 5000);

      // 验证失败，重置验证状态
      this.plugin.settings.tokenValidated = false;
      await this.plugin.saveSettings();

      // 刷新概览页面显示
      if (this.currentTab === 'overview') {
        this.renderCurrentTab();
      }
    } finally {
      button.setButtonText(originalText);
      button.setDisabled(false);
    }
  }
}
