/**
 * Flomo API 类型定义
 *
 * 基于 flomo-skills 参考实现整理的数据模型
 */

/** 单个附件文件 */
export interface FlomoFile {
  name: string;
  url: string;
}

/** 单条 flomo memo */
export interface FlomoMemo {
  /** 唯一标识，如 "MTI3MTMwMzQ0" */
  slug: string;
  /** HTML 格式内容 */
  content: string;
  /** 标签数组，如 ["英语/如何学习"] */
  tags: string[];
  /** 创建时间，格式 "2024-07-11 00:20:04" */
  created_at: string;
  /** 更新时间，格式 "2024-07-11 00:20:04" */
  updated_at: string;
  /** 来源，如 "android", "ios", "web" */
  source: string;
  /** 删除时间，存在且不为 null 时表示已在服务端删除 */
  deleted_at?: string | null;
  /** 附件列表 */
  files?: FlomoFile[];
}

/** API 响应结构 */
export interface FlomoApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

/** 同步游标 - 用于增量同步 */
export interface SyncCursor {
  /** 上次同步的最大 updated_at 时间戳 */
  latest_updated_at: number;
  /** 上次最后一条 memo 的 slug */
  latest_slug: string;
  /** 上次同步时间（ISO 字符串） */
  last_sync_time?: string;
}

/** 同步结果统计 */
export interface SyncStats {
  /** 本次同步新增数量 */
  created: number;
  /** 本次同步更新数量 */
  updated: number;
  /** 本次同步跳过数量 */
  skipped: number;
  /** 本次同步失败数量 */
  failed: number;
  /** 本次同步删除数量 */
  deleted: number;
  /** 总处理数量 */
  total: number;
  /** 同步开始时间 */
  startTime: Date;
  /** 同步结束时间 */
  endTime?: Date;

  /** B-C 段（真正新增内容）的统计 */
  newContent?: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    deleted: number;
    total: number;
  };

  /** A-B 段（容错缓冲区）的统计 - 只记录 created/updated */
  bufferZone?: {
    created: number;
    updated: number;
    total: number;
  };
}

/** 上次同步统计 - 用于持久化 */
export interface LastSyncStats {
  /** 新增数量 */
  created: number;
  /** 更新数量 */
  updated: number;
  /** 跳过数量 */
  skipped: number;
  /** 失败数量 */
  failed: number;
  /** 删除数量 */
  deleted: number;
  /** 总处理数量 */
  total: number;
  /** 同步时间戳 */
  timestamp: number;
  /** 耗时（秒） */
  duration: number;

  /** B-C 段（真正新增内容）的统计 */
  newContent?: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    deleted: number;
    total: number;
  };

  /** A-B 段（容错缓冲区）的统计 */
  bufferZone?: {
    created: number;
    updated: number;
    total: number;
  };
}

/** 同步状态 */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success';

/** 错误详情 */
export interface ErrorDetails {
  /** 错误消息 */
  message: string;
  /** 错误代码（API 返回） */
  code?: number;
  /** HTTP 状态码 */
  status?: number;
  /** 错误发生时间戳 */
  timestamp: number;
}

/** 文件操作结果 */
export type FileOperationResult = 'created' | 'updated' | 'skipped' | 'failed' | 'deleted';

/** 同步配置 */
export interface SyncConfig {
  /** flomo token */
  token: string;
  /** 目标目录（相对于 vault root） */
  targetDir: string;
  /** 是否下载附件 */
  downloadAttachments: boolean;
  /** 同步间隔（分钟），0 表示不自动同步 */
  syncInterval: number;
  /** 是否启用调试日志 */
  debugMode: boolean;
}
