/**
 * Flomo API 客户端
 *
 * 封装请求、分页、错误处理、签名算法
 */

import { requestUrl } from 'obsidian';
import type { FlomoMemo, FlomoApiResponse, SyncConfig } from './types';

// Sign 算法常量（来自 flomo-skills 逆向）
const SIGN_SECRET = 'dbbc3dd73364b4084c3a69346e0ce2b2';
const BASE_URL = 'https://flomoapp.com/api/v1';
const LIMIT = 200;

/** 自定义错误类型 */
export class FlomoApiError extends Error {
  constructor(
    message: string,
    public code?: number,
    public status?: number
  ) {
    super(message);
    this.name = 'FlomoApiError';
  }
}

/**
 * 生成 API 请求签名
 *
 * 规则：
 * 1. 按固定顺序排列（与 URL 参数顺序一致）
 * 2. 跳过值为 null/undefined/"" 的参数
 * 3. 列表类型：key[]=value，value 排序
 * 4. 追加 secret 后取 MD5
 */
function generateSign(params: Record<string, string | string[]>): string {
  // 按 key 字典序排序（签名算法要求）
  const sortedKeys = Object.keys(params).sort();
  const parts: string[] = [];

  for (const key of sortedKeys) {
    const value = params[key];
    if (Array.isArray(value)) {
      const filtered = value.filter(x => x !== '').sort();
      for (const item of filtered) {
        parts.push(`${key}[]=${item}`);
      }
    } else if (value !== '') {
      parts.push(`${key}=${value}`);
    }
  }

  const qs = parts.join('&');
  const signStr = qs + SIGN_SECRET;

  return simpleMD5(signStr);
}

/**
 * 简单的 MD5 实现（用于 Obsidian 浏览器环境）
 *
 * TODO: 如果性能成为问题，可以考虑使用 wasm 版本的 crypto
 */
function simpleMD5(str: string): string {
  // 使用现成的 MD5 实现
  return md5(str);
}

/**
 * MD5 哈希函数（基于 RFC 1321 参考实现）
 */
function md5(input: string): string {
  const hexChars = '0123456789abcdef';

  // 初始化 MD5 常量
  const s: number[] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const K: number[] = [];
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  // 转换为字节数组
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    bytes.push(input.charCodeAt(i) & 0xff);
  }

  // 填充
  const originalLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length * 8 + 64) % 512 !== 0) {
    bytes.push(0);
  }

  // 追加长度（64 位小端）
  // 注意：JS 位移会对位数取模 32，直接使用 >>> 32 会错误地等价为 >>> 0
  const lenLow = originalLen >>> 0;
  const lenHigh = Math.floor(originalLen / 0x100000000) >>> 0;
  for (let i = 0; i < 4; i++) {
    bytes.push((lenLow >>> (i * 8)) & 0xff);
  }
  for (let i = 0; i < 4; i++) {
    bytes.push((lenHigh >>> (i * 8)) & 0xff);
  }

  // 处理每个 512-bit 块
  for (let i = 0; i < bytes.length; i += 64) {
    const chunk = bytes.slice(i, i + 64);
    const M: number[] = [];
    for (let j = 0; j < 16; j++) {
      M[j] =
        chunk[j * 4] |
        (chunk[j * 4 + 1] << 8) |
        (chunk[j * 4 + 2] << 16) |
        (chunk[j * 4 + 3] << 24);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let j = 0; j < 64; j++) {
      let F: number, g: number;
      if (j < 16) {
        F = (B & C) | (~B & D);
        g = j;
      } else if (j < 32) {
        F = (D & B) | (~D & C);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        F = B ^ C ^ D;
        g = (3 * j + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * j) % 16;
      }

      const temp = D;
      D = C;
      C = B;
      B = (B + leftRotate(A + F + K[j] + M[g], s[j])) >>> 0;
      A = temp;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  function leftRotate(x: number, c: number): number {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  function toHex(n: number): string {
    // 小端序输出：byte0 byte1 byte2 byte3
    const b0 = n & 0xff;
    const b1 = (n >>> 8) & 0xff;
    const b2 = (n >>> 16) & 0xff;
    const b3 = (n >>> 24) & 0xff;

    function byteToHex(b: number): string {
      return hexChars[(b >>> 4) & 0xf] + hexChars[b & 0xf];
    }

    return byteToHex(b0) + byteToHex(b1) + byteToHex(b2) + byteToHex(b3);
  }

  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

/** Flomo API 客户端 */
export class FlomoClient {
  private token: string;

  constructor(config: SyncConfig) {
    // 自动去除 Bearer 前缀
    let token = config.token.trim();
    if (token.toLowerCase().startsWith('bearer ')) {
      token = token.slice(7).trim();
    }
    this.token = token;
  }

  /** 构建请求参数 */
  private buildParams(extra: Record<string, string | number>): Record<string, string> {
    // 所有参数转为字符串，与 Python 保持一致（包括 0 转为 "0"）
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) {
      params[k] = String(v);
    }

    params.timestamp = String(Math.floor(Date.now() / 1000));
    params.api_key = 'flomo_web';
    params.app_version = '4.0';
    params.platform = 'web';
    params.webp = '1';
    params.sign = generateSign(params);
    return params;
  }

  /** 构建请求头 */
  private buildHeaders(): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${this.token}`,
      origin: 'https://v.flomoapp.com',
      referer: 'https://v.flomoapp.com/',
      'device-id': '503b6439-1884-443d-b04e-0828bf9f138f',
      'device-model': 'Chrome',
      platform: 'Web',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
  }

  /**
   * 拉取一页 memo
   *
   * @param latestUpdatedAt - 上次同步的最大 updated_at 时间戳
   * @param latestSlug - 上次最后一条 memo 的 slug
   * @returns memo 列表
   */
  async fetchMemosPage(
    latestUpdatedAt: number,
    latestSlug: string
  ): Promise<FlomoMemo[]> {
    const params = this.buildParams({
      limit: LIMIT,
      // flomo 首次全量请求使用空字符串，而不是 "0"
      latest_updated_at: latestUpdatedAt > 0 ? latestUpdatedAt : '',
      latest_slug: latestSlug ?? '',
      tz: '8:0',
    });

    // 按固定顺序构建 URL（与 flomo 网页版一致）
    // 顺序：limit, latest_updated_at, latest_slug, tz, timestamp, api_key, app_version, platform, webp, sign
    const orderedKeys = ['limit', 'latest_updated_at', 'latest_slug', 'tz', 'timestamp', 'api_key', 'app_version', 'platform', 'webp', 'sign'];
    const queryString = orderedKeys
      .map(k => `${k}=${params[k]}`)
      .join('&');

    const url = `${BASE_URL}/memo/updated/?${queryString}`;

    try {
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (response.status !== 200) {
        throw new FlomoApiError(`HTTP ${response.status}`, undefined, response.status);
      }

      const body = response.json as FlomoApiResponse<FlomoMemo[]>;


      if (body.code !== 0) {
        // 处理特定错误码
        if (body.code === -1 && body.message?.includes('sign')) {
          throw new FlomoApiError('签名错误，请检查 token 是否有效', body.code);
        }
        if (body.message?.includes('登录') || body.message?.includes('auth')) {
          throw new FlomoApiError('登录已过期，请重新获取 token', body.code, 401);
        }
        throw new FlomoApiError(body.message || 'API 错误', body.code);
      }

      return body.data || [];
    } catch (e) {
      if (e instanceof FlomoApiError) {
        throw e;
      }

      // 处理网络错误
      const err = e as Error;
      if (err.message?.includes('Request')) {
        throw new FlomoApiError('网络请求失败，请检查网络连接', undefined, 0);
      }

      throw new FlomoApiError(`请求失败: ${err.message}`);
    }
  }

  /**
   * 分页获取所有 memo
   *
   * @param afterTs - 起始 updated_at 时间戳（含），0 表示从最早开始
   * @param onPage - 每页回调，用于进度显示
   * @returns 所有 memo 的异步生成器
   */
  async *iterMemos(
    afterTs: number = 0,
    onPage?: (page: number, count: number, cursor: { updatedAt: number; slug: string }) => void
  ): AsyncGenerator<FlomoMemo[], void, unknown> {
    let latestUpdatedAt = afterTs;
    let latestSlug = '';
    let page = 1;

    while (true) {

      const items = await this.fetchMemosPage(latestUpdatedAt, latestSlug);

      if (onPage) {
        onPage(page, items.length, { updatedAt: latestUpdatedAt, slug: latestSlug });
      }

      if (!items || items.length === 0) {
        break;
      }

      yield items;

      // 如果返回条数小于 limit，说明已到达末尾
      if (items.length < LIMIT) {
        break;
      }

      // 更新游标
      const last = items[items.length - 1];
      const lastUpdatedAt = last.updated_at;

      // 解析时间戳
      if (typeof lastUpdatedAt === 'string') {
        latestUpdatedAt = Math.floor(new Date(lastUpdatedAt).getTime() / 1000);
      } else {
        latestUpdatedAt = Math.floor(Number(lastUpdatedAt));
      }
      latestSlug = last.slug;

      page++;

      // 礼貌性限速
      await sleep(300);
    }
  }

  /**
   * 下载附件
   *
   * @param url - 附件 URL
   * @returns ArrayBuffer 或 null（下载失败）
   */
  async downloadAttachment(url: string): Promise<ArrayBuffer | null> {
    try {
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: {
          referer: 'https://v.flomoapp.com/',
        },
      });

      if (response.status !== 200) {
        return null;
      }

      return response.arrayBuffer;
    } catch {
      return null;
    }
  }
}

/** 延迟函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
