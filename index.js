#!/usr/bin/env node
/**
 * xiaohongshu-mcp
 * 小红书 MCP server：登录一次（扫码，Playwright 持久化 Profile），
 * 之后 AI 可调用 search_notes / get_note_detail / get_note_comments。
 *
 * 运行要求：本机装有 Google Chrome（或 Edge / Playwright Chromium）。
 * 数据目录：~/.xiaohongshu-mcp/（浏览器 Profile，删除即登出）。
 * 环境变量：XHS_HEADLESS=1 时搜索等操作使用无头浏览器（默认有头，更不易触发风控）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME_URL = 'https://www.xiaohongshu.com';
const DATA_DIR = process.env.XHS_DATA_DIR || path.join(os.homedir(), '.xiaohongshu-mcp');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
const HEADLESS = ['1', 'true', 'yes'].includes((process.env.XHS_HEADLESS || '').toLowerCase());
const IDLE_MS = 10 * 60_000; // 共享浏览器空闲 10 分钟自动关闭
const LOGIN_TIMEOUT_MS = 5 * 60_000;

fs.mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asText = (v) => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

// ---------------------------------------------------------------------------
// 浏览器管理：单实例持久化 Profile，所有工具共用；空闲自动回收
// ---------------------------------------------------------------------------
let shared = null; // { ctx, page, lastUsed }
let idleTimer = null;
let capturedCommon = null; // 从页面真实请求捕获的 x-s-common（设备头，可复用）

function attachHeaderCapture(page) {
  page.on('request', (req) => {
    try {
      const h = req.headers();
      if (h['x-s-common'] && Date.now() - (capturedCommon?.ts ?? 0) > 5 * 60_000) {
        capturedCommon = { value: h['x-s-common'], ts: Date.now() };
      }
    } catch {}
  });
}

function browserArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--mute-audio',
    '--window-size=1280,900',
  ];
}

async function launchBrowser(headless) {
  const base = { viewport: null, args: browserArgs(), timeout: 60_000 };
  const candidates = [
    { ...base, channel: 'chrome', headless },
    { ...base, channel: 'msedge', headless },
    { ...base, headless },
  ];
  let errs = [];
  for (const opt of candidates) {
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, opt);
      await ctx.addInitScript(
        `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`
      );
      return ctx;
    } catch (e) {
      errs.push(`${opt.channel || 'chromium'}: ${String(e.message).split('\n')[0].slice(0, 160)}`);
    }
  }
  throw new Error(
    `无法启动浏览器：${errs.join(' | ')}。若本机没有 Chrome/Edge，请运行 npx playwright install chromium`
  );
}

async function closeShared() {
  clearTimeout(idleTimer);
  if (!shared) return;
  const s = shared;
  shared = null;
  await Promise.race([s.ctx.close().catch(() => {}), sleep(3000)]);
  killStrayBrowsers();
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (!shared) return;
    if (Date.now() - shared.lastUsed < IDLE_MS) {
      armIdleTimer();
      return;
    }
    console.error('[xhs] idle, closing browser');
    await closeShared();
  }, IDLE_MS);
  idleTimer.unref();
}

/** 取共享页面；失效或不存在则启动浏览器并打开首页 */
async function openPage() {
  if (loginSession) {
    throw new Error('二维码登录进行中（浏览器窗口已打开），请先完成扫码，或等用户扫完后用 check_login 确认');
  }
  if (shared) {
    try {
      await shared.page.evaluate(() => true);
      shared.lastUsed = Date.now();
      return shared.page;
    } catch {
      await closeShared();
    }
  }
  const ctx = await launchBrowser(HEADLESS);
  const page = ctx.pages()[0] || (await ctx.newPage());
  attachHeaderCapture(page);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  shared = { ctx, page, lastUsed: Date.now() };
  armIdleTimer();
  return page;
}

/**
 * 登录判定：优先用页面自证（未登录时搜索框 placeholder 为"登录探索更多内容"），
 * 因为 web_session cookie 可能存在但 session 已被服务端失效（此时 API 一律 500 invoker failed）。
 * 注意：SSR 初始 placeholder 恒为未登录文案，客户端 hydration 后才更新为个性化文案，
 * 因此首次读到"登录"时需隔 2 秒复查一次，避免把已登录误判为未登录。
 */
/**
 * 登录判定：等页面 placeholder 变为已登录文案（SSR 初始值恒为"登录探索更多内容"，
 * hydration 后才更新为个性化文案，因此必须等变化而不是读一次）。
 * 6 秒后仍是未登录文案 → 页面自证未登录（此时 cookie 存在也不算数，session 必已失效）。
 */
async function isLoggedIn(page) {
  try {
    const ok = await page
      .waitForFunction(
        () => {
          const ph = document.querySelector('#search-input')?.getAttribute('placeholder') || '';
          return ph && !ph.includes('登录');
        },
        null,
        { timeout: 6000 }
      )
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
    const ph = await page
      .$eval('#search-input', (el) => el.getAttribute('placeholder') || '')
      .catch(() => '');
    if (ph.includes('登录')) return false;
  } catch {}
  try {
    const cookies = await page.context().cookies(HOME_URL);
    return Boolean(cookies.find((c) => c.name === 'web_session')?.value); // 兜底：仅 placeholder 拿不到时
  } catch {
    return false;
  }
}

async function loginGuard() {
  const page = await openPage();
  // 判定缓存：同一浏览器实例 5 分钟内不重复回首页判定（避免每次工具调用多一次导航，
  // 把冷启动路径压进客户端 30s 工具超时以内）
  if (shared.verifiedAt && Date.now() - shared.verifiedAt < 5 * 60_000) return { page };
  // 登录判定固定在首页做：其他页面（搜索结果页等）的 placeholder 语义不一致
  if (!/^https:\/\/www\.xiaohongshu\.com\/(explore)?\/?$/.test(page.url().split('?')[0])) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null);
  }
  if (!(await isLoggedIn(page))) {
    return {
      error:
        '小红书登录态缺失或已失效（cookie 可能在但 session 已过期，特征是接口 500 invoker failed）。请提示用户调用 xiaohongshu 的 login 工具重新扫码。',
    };
  }
  shared.verifiedAt = Date.now();
  return { page };
}

/** 等待并确认页面签名函数可用 */
async function ensureSignFn(page) {
  try {
    await page.waitForFunction(() => typeof window._webmsxyw === 'function', null, {
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 小红书 Web API（在已登录页面上下文内发起，自动带 cookie + x-s/x-t 签名）
// ---------------------------------------------------------------------------
async function apiPost(page, uri, data) {
  const common = capturedCommon && Date.now() - capturedCommon.ts < 12 * 3600_000
    ? capturedCommon.value
    : null;
  return page.evaluate(
    async ({ uri, data, common }) => {
      const sign = window._webmsxyw(uri, data);
      const headers = {
        'content-type': 'application/json;charset=UTF-8',
        'x-s': sign['X-s'] ?? sign['x-s'],
        'x-t': String(sign['X-t'] ?? sign['x-t']),
      };
      if (common) headers['x-s-common'] = common;
      const res = await fetch('https://www.xiaohongshu.com' + uri, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, rawHead: json ? undefined : text.slice(0, 300) };
    },
    { uri, data, common }
  );
}

function apiError(j, status, rawHead) {
  if (!j)
    return `接口无响应（HTTP ${status}）：${
      (rawHead || '').includes('invoker failed')
        ? '网关拒绝，通常是未登录或登录态失效'
        : '可能被风控拦截'
    }，建议用户调用 login 工具（若刚登录过则重新调用完成验证）`;
  if (j.code === -100) return '登录态已失效（code -100），请提示用户重新调用 login 工具扫码登录';
  if (j.code === 461)
    return '触发风控验证（code 461），请提示用户调用 login 工具打开浏览器完成验证后重试';
  if (j.code === 300012 || /ip存在风险/i.test(String(j.msg ?? '')))
    return 'IP 被小红书标记为风险（300012）。若在用代理请关闭代理后重试；本机住宅网络一般不会触发。';
  return `接口返回错误：HTTP ${status}, code=${j.code}, msg=${j.msg ?? ''}`;
}

// ---------------------------------------------------------------------------
// 业务函数
// ---------------------------------------------------------------------------
// 操作串行化：同一时刻只允许一个工具驱动共享页面，避免并发调用互相干扰
let opQueue = Promise.resolve();
function withLock(fn) {
  const run = opQueue.catch(() => {}).then(fn);
  opQueue = run.catch(() => {});
  return run;
}

// 点赞数标准化："1.2万"/"1.2w" → 12000，"999+" → 999，数字原样返回
function stdLikes(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  let s = String(raw).trim();
  if (!s) return 0;
  if (s.endsWith('+')) s = s.slice(0, -1).trim();
  const m = s.match(/^([\d.]+)\s*(万|w)?$/i);
  if (m) {
    const n = parseFloat(m[1]);
    return Math.round(m[2] ? n * 10000 : n);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** 检查页面是否处于风控/登录失效状态，返回分类后的错误信息（null = 正常） */
function detectPageState(url, pageText) {
  const t = pageText || '';
  if (/error_code=300012|ip存在风险|ip 存在风险/i.test(url + t))
    return 'IP 被小红书标记为风险（300012）。本机走住宅网络一般不会触发；若在使用代理，请关闭代理后重试。';
  if (/passport|\/login/i.test(url)) return '页面被重定向到登录页，登录态已失效，请重新调用 login 工具扫码。';
  if (/验证|滑块|验证码|人机验证/.test(t))
    return '小红书弹出验证码/滑块验证，请调用 login 工具打开浏览器，手动完成验证后重试。';
  return null;
}

/** 搜索降级路线：直接打开搜索结果页做 DOM 提取（签名 API 被风控时使用） */
async function doSearchViaDom(page, keyword, limit) {
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(
    keyword
  )}&source=web_explore_feed&type=51`;
  // 直接导航搜索页在部分风控状态下会被挂起，超时设短一些
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForSelector('a[href*="xsec_token"]', { timeout: 10_000 }).catch(() => null);
  await sleep(1500);
  const raw = await page.evaluate(() => {
    const pageText = document.body ? document.body.innerText.slice(0, 2000) : '';
    const re = /\/(explore|search_result|discovery\/item)\/([0-9a-f]{16,})/;
    const seen = new Set();
    const items = [];
    for (const link of document.querySelectorAll('a[href*="xsec_token"]')) {
      const href = link.getAttribute('href') || '';
      const m = href.match(re);
      if (!m) continue;
      const id = m[2];
      if (seen.has(id)) continue;
      seen.add(id);
      const u = new URL(href, location.origin);
      const title =
        (link.getAttribute('aria-label') || '').trim() || link.innerText.trim().slice(0, 120);
      items.push({
        note_id: id,
        xsec_token: u.searchParams.get('xsec_token') || '',
        title,
        link: `https://www.xiaohongshu.com/explore/${id}`,
      });
    }
    return { url: location.href, pageText, items };
  });
  const stateErr = detectPageState(raw.url, raw.pageText);
  if (stateErr) return { error: stateErr };
  if (!raw.items.length) return { error: '降级提取也未获得结果（页面无笔记卡片）' };
  return {
    keyword,
    count: Math.min(raw.items.length, limit),
    via: 'dom_fallback',
    notes: raw.items.slice(0, limit).map((it) => ({ ...it, type: '', author: '', liked_count: 0 })),
  };
}

/** 主路线：像真人一样在搜索框输入并提交，拦截页面自己发出的签名搜索 XHR（结构化 JSON） */
async function doSearchViaUI(page, keyword, limit) {
  const captured = [];
  const onRes = async (res) => {
    if (/\/api\/sns\/web\/v\d+\/search\/notes/.test(res.url())) {
      try {
        captured.push(await res.json());
      } catch {}
    }
  };
  page.on('response', onRes);
  try {
    // 搜索固定在首页做：首页搜索框行为最标准，也避免在其他页面白等特征元素
    if (!/^https:\/\/www\.xiaohongshu\.com\/(explore)?\/?$/.test(page.url().split('?')[0])) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    const input = await page.waitForSelector('#search-input', { timeout: 10_000 });
    // 等 Vue 应用挂载完成（feed 卡片出现）：过早 type 的值不会被组件接管
    await page.waitForSelector('a[href*="/explore/"]', { timeout: 6_000 }).catch(() => null);
    await sleep(800);
    await input.click();
    await page.keyboard.type(keyword, { delay: 50 });
    await page.keyboard.press('Enter');
    let deadline = Date.now() + 12_000;
    while (!captured.length && Date.now() < deadline) await sleep(500);
    if (!captured.length) {
      // Enter 未提交时重输一次再点搜索按钮
      await page.click('#search-input', { clickCount: 3 });
      await page.keyboard.type(keyword, { delay: 50 });
      await page.keyboard.press('Enter');
      await page.click('.input-button').catch(() => null);
      deadline = Date.now() + 8_000;
      while (!captured.length && Date.now() < deadline) await sleep(500);
    }
    await sleep(1000); // 多收一拍瀑布流数据
  } finally {
    page.off('response', onRes);
  }
  if (!captured.length) {
    return { error: '页面未发出搜索请求（可能未登录或被风控，建议调用 login 工具）' };
  }
  const seen = new Set();
  const notes = [];
  for (const j of captured) {
    const items = j?.data?.items || j?.data?.notes || [];
    for (const it of items) {
      const nc = it.note_card || it;
      const id = nc.note_id || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      notes.push({
        note_id: id,
        xsec_token: it.xsec_token || nc.xsec_token || '',
        title: nc.display_title || '',
        type: nc.type === 'video' ? '视频' : '图文',
        author: nc.user?.nickname || '',
        liked_count: stdLikes(nc.interact_info?.liked_count),
        link: `https://www.xiaohongshu.com/explore/${id}`,
      });
    }
  }
  if (!notes.length) {
    const diag = await page
      .evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 600) || '' }))
      .catch(() => null);
    const stateErr = diag && detectPageState(diag.url, diag.text);
    return { error: stateErr || '搜索请求已发出但无结果（关键词可能无内容）' };
  }
  return { keyword, count: Math.min(notes.length, limit), via: 'page_xhr', notes: notes.slice(0, limit) };
}

/** 备选路线：在页面上下文内用 _webmsxyw 签名直接调搜索 API（可翻页） */
async function doSearchViaApi(page, keyword, limit) {
  const notes = [];
  let pageNum = 1;
  while (notes.length < limit && pageNum <= 5) {
    const payload = {
      keyword,
      page: pageNum,
      page_size: 20,
      search_id: '',
      extend_type: 'note',
      cover_ratio: '1',
      order: 'general',
      note_index: (pageNum - 1) * 20,
      image_formats: ['jpg', 'webp', 'avif'],
    };
    const r = await apiPost(page, '/api/sns/web/v1/search/notes', payload);
    const j = r.json;
    if (!j || j.success !== true) return { error: apiError(j, r.status, r.rawHead) };
    const items = j.data?.items || j.data?.notes || [];
    for (const it of items) {
      const nc = it.note_card || it;
      const id = nc.note_id || it.id;
      if (!id) continue;
      notes.push({
        note_id: id,
        xsec_token: it.xsec_token || nc.xsec_token || '',
        title: nc.display_title || '',
        type: nc.type === 'video' ? '视频' : '图文',
        author: nc.user?.nickname || '',
        liked_count: stdLikes(nc.interact_info?.liked_count),
        link: `https://www.xiaohongshu.com/explore/${id}`,
      });
    }
    if (!j.data?.has_more || items.length === 0) break;
    pageNum++;
    await sleep(700 + Math.random() * 700); // 翻页间隔，温和访问
  }
  if (!notes.length) return { error: 'API 返回空结果' };
  return { keyword, count: Math.min(notes.length, limit), via: 'signed_api', notes: notes.slice(0, limit) };
}

async function doSearch(keyword, limit = 20, { skipLoginCheck = false } = {}) {
  const guard = skipLoginCheck
    ? await openPage().then((page) => ({ page }))
    : await loginGuard();
  if (guard.error) return guard;
  const page = guard.page;
  shared.lastUsed = Date.now();

  // 主路线：页面自己发签名请求，最不易被风控
  const viaUI = await doSearchViaUI(page, keyword, limit).catch((e) => ({ error: String(e) }));
  if (!viaUI.error) return viaUI;

  // 备选：页面内签名直调
  if (await ensureSignFn(page)) {
    const viaApi = await doSearchViaApi(page, keyword, limit).catch((e) => ({ error: String(e) }));
    if (!viaApi.error) return viaApi;
  }

  // 兜底：搜索结果页 DOM 提取（直接导航，登录态有效时才可用）
  const viaDom = await doSearchViaDom(page, keyword, limit).catch(() => null);
  if (viaDom && !viaDom.error) return viaDom;

  return { error: viaUI.error };
}

async function getNoteDetail(noteId, xsecToken, xsecSource) {
  const guard = await loginGuard();
  if (guard.error) return guard;
  const page = guard.page;
  shared.lastUsed = Date.now();

  const url =
    `https://www.xiaohongshu.com/explore/${noteId}` +
    (xsecToken
      ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=${xsecSource || 'pc_search'}`
      : '');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page
    .waitForFunction(() => window.__INITIAL_STATE__ !== undefined, null, { timeout: 10_000 })
    .catch(() => null);

  const data = await page.evaluate((nid) => {
    let s = window.__INITIAL_STATE__;
    if (typeof s === 'string') {
      try {
        s = JSON.parse(s);
      } catch {
        return null;
      }
    }
    const map = s?.note?.noteDetailMap || {};
    // 严格按 note_id 索引：map 里还会混入相关推荐笔记，不能取第一个 key
    let n = map[nid]?.note;
    if (!n) {
      for (const k of Object.keys(map)) {
        if (map[k]?.note?.noteId === nid || map[k]?.note?.note_id === nid) {
          n = map[k].note;
          break;
        }
      }
    }
    if (!n) n = s?.note?.currentNote;
    if (!n) return null;
    return {
      title: n.title || '',
      desc: n.desc || '',
      publish_date: n.time
        ? new Date(Number(n.time) * 1000).toISOString().slice(0, 10)
        : n.lastUpdateTime || '',
      ip_location: n.ipLocation || '',
      author: n.user?.nickname || '',
      liked: n.interactInfo?.likedCount ?? '',
      collected: n.interactInfo?.collectedCount ?? '',
      comment_count: n.interactInfo?.commentCount ?? '',
      tags: (n.tagList || []).map((t) => t.name).filter(Boolean),
    };
  }, noteId);

  if (!data) {
    // 状态诊断：区分登录失效 / 验证码 / IP 风控 / token 过期
    const diag = await page
      .evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 600) || '' }))
      .catch(() => null);
    const stateErr = diag && detectPageState(diag.url, diag.text);
    if (stateErr) return { error: stateErr };
    // 兜底：直接读 DOM（页面结构变化或状态未注入时）
    const domData = await page
      .evaluate(() => {
        const q = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
        return {
          title: q('#detail-title') || q('h1'),
          desc: q('#detail-desc'),
          author: q('.username'),
        };
      })
      .catch(() => null);
    if (domData && (domData.title || domData.desc)) {
      return {
        note_id: noteId,
        link: url,
        ...domData,
        note: '（由 DOM 兜底提取，互动数据缺失。若 desc 为空可能是笔记需登录或已删除）',
      };
    }
    return {
      error:
        '无法读取笔记内容：可能 xsec_token 缺失/过期（请从 search_notes 结果中取最新 xsec_token），或笔记已删除',
    };
  }
  return {
    note_id: noteId,
    link: url,
    ...data,
    liked: stdLikes(data.liked),
    collected: stdLikes(data.collected),
    comment_count: stdLikes(data.comment_count),
  };
}

function countCaptured(captured) {
  return captured.reduce((n, j) => n + (j.data?.comments?.length || 0), 0);
}

async function getComments(noteId, xsecToken, limit = 30, xsecSource) {
  const guard = await loginGuard();
  if (guard.error) return guard;
  const page = guard.page;
  shared.lastUsed = Date.now();

  // 主路线：打开笔记页拦截页面自己的评论 XHR（复刻签名直调会被网关 500 拒）
  const viaPage = await getCommentsViaPage(page, noteId, xsecToken, limit, xsecSource).catch(
    (e) => ({ error: String(e) })
  );
  if (!viaPage.error) return viaPage;

  // 备选：页面上下文内签名直调（可翻页，但历史经验常被网关拒）
  if (await ensureSignFn(page)) {
    const flat = [];
    let cursor = '';
    for (let round = 0; round < 5 && flat.length < limit; round++) {
      const data = {
        note_id: noteId,
        cursor,
        top_comment_id: '',
        image_formats: ['jpg', 'webp', 'avif'],
      };
      if (xsecToken) data.xsec_token = xsecToken;
      const r = await apiPost(page, '/api/sns/web/v1/comment/page', data);
      const j = r.json;
      if (!j || j.success !== true) break;
      const comments = j.data?.comments || [];
      for (const c of comments) {
        flat.push({
          author: c.user?.nickname || '',
          content: c.content || '',
          likes: stdLikes(c.like_count),
          time: c.time ? new Date(Number(c.time)).toISOString().slice(0, 10) : '',
          ip_location: c.ip_location || '',
          sub_comments: (c.sub_comments || []).map((s) => ({
            author: s.user?.nickname || '',
            content: s.content || '',
            likes: stdLikes(s.like_count),
          })),
        });
      }
      cursor = j.data?.cursor || '';
      if (!j.data?.has_more || comments.length === 0) break;
      await sleep(600 + Math.random() * 600);
    }
    if (flat.length) {
      return { note_id: noteId, count: Math.min(flat.length, limit), via: 'signed_api', comments: flat.slice(0, limit) };
    }
  }
  return { error: viaPage.error };
}

/** 评论主路线：打开笔记页，拦截页面自己发的评论 XHR，滚动加载更多 */
async function getCommentsViaPage(page, noteId, xsecToken, limit, xsecSource) {
  const url =
    `https://www.xiaohongshu.com/explore/${noteId}` +
    (xsecToken
      ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=${xsecSource || 'pc_search'}`
      : '');
  const captured = [];
  const onRes = async (res) => {
    if (/\/api\/sns\/web\/v\d+\/comment\//.test(res.url())) {
      try {
        const j = await res.json();
        if (j?.success) captured.push(j);
      } catch {}
    }
  };
  page.on('response', onRes);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // 笔记页会自动请求首屏评论
    let deadline = Date.now() + 8000;
    while (!captured.length && Date.now() < deadline) await sleep(500);
    // 向下滚动评论区加载更多
    for (let round = 0; round < 3; round++) {
      if (countCaptured(captured) >= limit) break;
      const before = countCaptured(captured);
      await page
        .evaluate(() => {
          const sc =
            document.querySelector('.note-scroller') ||
            document.querySelector('.comments-el')?.closest('[class*=scroll]') ||
            document.scrollingElement;
          if (sc) sc.scrollTop = sc.scrollTop + 1400;
        })
        .catch(() => null);
      await sleep(1800);
      if (countCaptured(captured) === before) break;
    }
  } finally {
    page.off('response', onRes);
  }

  // 解析拦截到的评论（结构与 API 直调一致）
  const seen = new Set();
  const flat = [];
  for (const j of captured) {
    for (const c of j.data?.comments || []) {
      if (!c?.content || seen.has(c.id)) continue;
      seen.add(c.id);
      flat.push({
        author: c.user?.nickname || '',
        content: c.content,
        likes: stdLikes(c.like_count),
        time: c.time ? new Date(Number(c.time)).toISOString().slice(0, 10) : '',
        ip_location: c.ip_location || '',
        sub_comments: (c.sub_comments || []).map((s) => ({
          author: s.user?.nickname || '',
          content: s.content || '',
          likes: stdLikes(s.like_count),
        })),
      });
    }
  }
  if (flat.length) {
    return {
      note_id: noteId,
      count: Math.min(flat.length, limit),
      via: 'page_xhr',
      comments: flat.slice(0, limit),
    };
  }

  // 兜底：__INITIAL_STATE__ 首屏评论
  await sleep(800);
  const raw = await page.evaluate((nid) => {
    let s = window.__INITIAL_STATE__;
    if (typeof s === 'string') {
      try {
        s = JSON.parse(s);
      } catch {
        s = null;
      }
    }
    const map = s?.note?.noteDetailMap || {};
    const entry = map[nid] || Object.values(map).find((e) => e?.note?.noteId === nid);
    const lists = [
      entry?.commentList,
      entry?.comments?.list,
      entry?.note?.commentList,
      entry?.note?.comments?.list,
    ].filter(Array.isArray);
    const seen = new Set();
    const comments = [];
    for (const list of lists) {
      for (const c of list) {
        const content = c?.content || c?.text || '';
        if (!content || seen.has(c.id ?? content)) continue;
        seen.add(c.id ?? content);
        comments.push({
          author: c.user?.nickname || c.userInfo?.nickname || '',
          content,
          likes: stdLikes(c.like_count ?? c.likeCount),
          time: c.createTime ? new Date(Number(c.createTime)).toISOString().slice(0, 10) : '',
        });
      }
    }
    return {
      url: location.href,
      pageText: document.body?.innerText?.slice(0, 1500) || '',
      comments,
    };
  }, noteId);
  const stateErr = detectPageState(raw.url, raw.pageText);
  if (stateErr) return { error: stateErr };
  if (!raw.comments.length) return { error: '未能加载评论（笔记可能无评论，或缺 xsec_token 无法打开笔记）' };
  return {
    note_id: noteId,
    count: Math.min(raw.comments.length, limit),
    via: 'state_fallback',
    comments: raw.comments.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// 私信：会话列表 + 好友分享的笔记
// 页面结构（2026-10 实测）：/chat 列表页拉 /api/.../chats；会话页 /chat/{id} 首屏
// 渲染最近消息，向上滚动触发 /api/im/web/messages/history 分页。分享笔记消息的
// content 是双层 JSON（外层 content_type=3，内层 type="note"，link 为
// xhsdiscover://item/{note_id}?...xsec_token=...）。
// ---------------------------------------------------------------------------
async function listChats() {
  const guard = await loginGuard();
  if (guard.error) return guard;
  const page = guard.page;
  shared.lastUsed = Date.now();

  const captured = [];
  const onRes = async (res) => {
    const u = res.url();
    if (/\/api\/(sns\/v1\/im\/web\/get_recent_chats|im\/web\/v3\/chats)\b/.test(u)) {
      try {
        captured.push(await res.json());
      } catch {}
    }
  };
  page.on('response', onRes);
  try {
    await page.goto('https://www.xiaohongshu.com/chat', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const deadline = Date.now() + 10_000;
    while (!captured.length && Date.now() < deadline) await sleep(700);
    await sleep(1000);
  } finally {
    page.off('response', onRes);
  }
  if (!captured.length) {
    return { error: '未捕获到会话列表接口（页面可能未登录或结构变化）' };
  }
  const chats = [];
  const seen = new Set();
  for (const j of captured) {
    const list = j?.data?.chats || j?.data?.list || [];
    for (const c of list) {
      const id = c.chat_user_id || c.chat_id || c.user_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      chats.push({
        chat_id: id,
        name: c.info?.nickname || c.name || '',
        is_friend: c.info?.is_friend ?? null,
        last_message: c.last_msg_content || c.last_msg || '',
      });
    }
  }
  if (!chats.length) return { error: '会话列表为空（可能无私信或结构变化）' };
  return { count: chats.length, chats };
}

/** 解析一条消息里的分享笔记；非笔记分享返回 null */
function parseSharedNote(msg, peerId) {
  let c1 = null;
  try {
    c1 = JSON.parse(msg.content);
  } catch {
    return null;
  }
  if (!c1 || c1.content_type !== 3) return null; // 3 = 卡片分享
  let c2 = null;
  try {
    c2 = JSON.parse(c1.content);
  } catch {
    return null;
  }
  if (!c2) return null;
  const link = c2.link || '';
  const isNote = c2.type === 'note' || link.includes('://item/');
  if (!isNote) return null;
  let noteId = c2.id || '';
  let token = '';
  try {
    const u = new URL(link.replace(/^xhsdiscover:\/\//, 'https://item.host/'));
    const m = u.pathname.match(/item\/([0-9a-f]{16,})/);
    if (m) noteId = m[1];
    token = u.searchParams.get('xsec_token') || '';
  } catch {}
  if (!noteId) return null;
  return {
    note_id: noteId,
    xsec_token: token,
    title: c2.title || c2.frontChain || '',
    author: c2.user?.nickname || '',
    sent_by_me: msg.sender_id !== peerId,
    sent_at: msg.created_at
      ? new Date(Number(msg.created_at)).toISOString().slice(0, 16).replace('T', ' ')
      : '',
    _ts: Number(msg.created_at) || 0,
  };
}

async function getChatNotes(chatId, limit = 20) {
  const guard = await loginGuard();
  if (guard.error) return guard;
  const page = guard.page;
  shared.lastUsed = Date.now();

  const msgs = [];
  const onRes = async (res) => {
    if (!res.url().includes('/api/im/web/messages/history')) return;
    try {
      const j = await res.json();
      for (const m of j?.data?.out_message_list || []) msgs.push(m);
    } catch {}
  };
  page.on('response', onRes);
  try {
    await page.goto(`https://www.xiaohongshu.com/chat/${chatId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await sleep(5000); // 首屏消息渲染
    // 向上滚动触发历史分页，直到无新数据
    for (let round = 0; round < 4; round++) {
      const before = msgs.length;
      await page.evaluate(() => {
        const w =
          document.querySelector('.xhs-im-msg-list-wrap') ||
          document.querySelector('.xhs-im-msg-list');
        if (w) {
          w.scrollTop = 0;
          w.dispatchEvent(new Event('scroll'));
        }
      });
      await sleep(2500);
      if (msgs.length === before) break;
    }
  } finally {
    page.off('response', onRes);
  }

  const notes = [];
  const seen = new Set();
  for (const m of msgs) {
    const n = parseSharedNote(m, chatId);
    if (!n || seen.has(n.note_id)) continue;
    seen.add(n.note_id);
    notes.push(n);
  }
  notes.sort((a, b) => b._ts - a._ts); // 最近分享在前
  for (const n of notes) delete n._ts;
  if (!notes.length) {
    return { chat_id: chatId, message_count: msgs.length, note_count: 0, notes: [], hint: '已扫描的消息中无笔记分享（历史更早的分享需在聊天里手动上滑更多）' };
  }
  return {
    chat_id: chatId,
    message_count: msgs.length,
    note_count: Math.min(notes.length, limit),
    notes: notes.slice(0, limit),
    hint: 'note_id/xsec_token 可直接传给 get_note_detail 读取正文（xsec_token 建议传 xsec_source=app_share）',
  };
}

// 登录会话：login 立即返回（客户端工具超时远短于人工扫码时间），后台等扫码，
// 结果缓存在 loginResult，由 check_login / 下一次调用取走。
let loginSession = null; // { ctx, page, startedAt, done }
let loginResult = null; // 扫码完成后的结果，等 check_login 消费

function startLogin() {
  if (loginSession && Date.now() - loginSession.startedAt < LOGIN_TIMEOUT_MS) {
    return {
      ok: true,
      message: '二维码窗口已打开，请在浏览器中完成扫码；扫完后调用 check_login 确认。',
    };
  }
  // 异步启动：弹窗失败也能在 check_login 里看到
  (async () => {
    await closeShared();
    let ctx, page;
    try {
      ctx = await launchBrowser(false);
      page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      loginResult = { ok: false, message: `打开浏览器失败：${String(e.message).split('\n')[0]}` };
      if (ctx) await closeCtx(ctx);
      return;
    }
    loginSession = { ctx, page, startedAt: Date.now() };
    console.error('[xhs] waiting for QR login...');
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (loginSession && Date.now() < deadline) {
      if (await isLoggedIn(page).catch(() => false)) {
        await sleep(3000); // 等 cookie 落盘
        const session = loginSession;
        loginSession = null;
        await closeCtx(session.ctx);
        await sleep(1500); // 等 Profile 锁释放
        // 后台自动验证一次搜索链路（走 UI 主路线，行为自然）
        let verify = null;
        try {
          verify = await doSearch('美食', 1);
        } catch (e) {
          verify = { error: String(e) };
        }
        const verified = verify && !verify.error;
        loginResult = {
          ok: true,
          message: '扫码登录成功，登录态已保存到本地 Profile。',
          search_verification: verified
            ? { ok: true, sample: verify.notes?.[0]?.title || '' }
            : { ok: false, detail: verify?.error || verify },
        };
        console.error('[xhs] QR login detected');
        return;
      }
      await sleep(3000);
    }
    if (loginSession) {
      const session = loginSession;
      loginSession = null;
      await closeCtx(session.ctx);
      loginResult = { ok: false, message: '5 分钟内未完成扫码，请重新调用 login 工具。' };
    }
  })();
  return {
    ok: true,
    message: '浏览器窗口已打开，请在 5 分钟内用小红书 App 扫码登录；完成后调用 check_login 确认结果。',
  };
}

async function checkLogin() {
  if (loginResult) {
    const r = loginResult;
    loginResult = null;
    return r;
  }
  if (loginSession) {
    return { status: 'pending', hint: '二维码登录进行中，请完成扫码后再调用 check_login。' };
  }
  const page = await openPage();
  if (!(await isLoggedIn(page))) {
    return { logged_in: false, hint: '未登录或登录态已失效，请调用 login 工具扫码' };
  }
  return { logged_in: true };
}

// ---------------------------------------------------------------------------
// MCP 注册
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'xiaohongshu', version: '0.1.0' });

server.registerTool(
  'login',
  {
    title: '小红书扫码登录',
    description:
      '弹出浏览器窗口显示小红书登录二维码，立即返回（不阻塞等待扫码）。用户扫码后，后台自动检测并跑一次搜索验证；请提示用户扫完后调用 check_login 查看登录与验证结果。',
    inputSchema: {},
  },
  async () => asText(startLogin())
);

server.registerTool(
  'check_login',
  {
    title: '检查小红书登录状态',
    description: '检查当前持久化 Profile 的登录状态，返回是否登录及昵称。',
    inputSchema: {},
  },
  async () => asText(await withLock(checkLogin))
);

server.registerTool(
  'search_notes',
  {
    title: '小红书搜索笔记',
    description:
      '按关键词搜索小红书笔记，返回笔记列表（标题、作者、点赞数、note_id、xsec_token、链接）。获取详情需把返回的 note_id 和 xsec_token 传给 get_note_detail。',
    inputSchema: {
      keyword: z.string().describe('搜索关键词，如"喀纳斯 攻略"'),
      limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 20'),
    },
  },
  async ({ keyword, limit }) => asText(await withLock(() => doSearch(keyword, limit ?? 20)))
);

server.registerTool(
  'get_note_detail',
  {
    title: '获取小红书笔记详情',
    description:
      '获取笔记正文（标题、正文、发布日期、作者、点赞/收藏/评论数、话题标签）。note_id 和 xsec_token 必须来自最近一次 search_notes 的结果（xsec_token 会过期）。',
    inputSchema: {
      note_id: z.string().describe('笔记 ID（search_notes 结果中的 note_id，或链接 /explore/ 后的部分）'),
      xsec_token: z
        .string()
        .optional()
        .describe('来自 search_notes / get_chat_notes 结果的 xsec_token，缺失可能无法读取正文'),
      xsec_source: z
        .string()
        .optional()
        .describe('token 来源：search_notes 默认 pc_search；私信分享的笔记传 app_share'),
    },
  },
  async ({ note_id, xsec_token, xsec_source }) =>
    asText(await withLock(() => getNoteDetail(note_id, xsec_token, xsec_source)))
);

server.registerTool(
  'get_note_comments',
  {
    title: '获取小红书笔记评论',
    description:
      '拉取笔记评论（含楼中楼），攻略类笔记评论区常有重要补充信息。note_id/xsec_token 来自 search_notes 结果。',
    inputSchema: {
      note_id: z.string().describe('笔记 ID'),
      xsec_token: z.string().optional().describe('来自 search_notes / get_chat_notes 结果的 xsec_token'),
      xsec_source: z
        .string()
        .optional()
        .describe('token 来源：search_notes 默认 pc_search；私信分享的笔记传 app_share'),
      limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 30'),
    },
  },
  async ({ note_id, xsec_token, xsec_source, limit }) =>
    asText(await withLock(() => getComments(note_id, xsec_token, limit ?? 30, xsec_source)))
);

server.registerTool(
  'list_chats',
  {
    title: '列出小红书私信会话',
    description:
      '列出当前账号最近的私信会话（chat_id、昵称、最后一条消息）。要查看好友分享的笔记，先用本工具拿到 chat_id，再调用 get_chat_notes。',
    inputSchema: {},
  },
  async () => asText(await withLock(listChats))
);

server.registerTool(
  'get_chat_notes',
  {
    title: '获取私信中分享的笔记',
    description:
      '打开指定私信会话，自动向上滚动加载历史消息，提取所有分享的笔记（标题、作者、note_id、xsec_token、分享时间、是好友发还是我发的）。返回结果可直接传给 get_note_detail 读正文（token 配 xsec_source=app_share）。',
    inputSchema: {
      chat_id: z.string().describe('会话 ID（来自 list_chats 结果的 chat_id，即 /chat/ 后的部分）'),
      limit: z.number().int().min(1).max(50).optional().describe('最多返回分享笔记数，默认 20'),
    },
  },
  async ({ chat_id, limit }) => asText(await withLock(() => getChatNotes(chat_id, limit ?? 20)))
);

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';

function killStrayBrowsers() {
  // 兜底：确保 Chrome 子进程不比本进程活得久（否则会泄漏并占住 stdio）。
  // 必须 -9：headful Chrome 收到 SIGTERM 可能挂着不退。
  try {
    spawnSync('pkill', ['-9', '-f', PROFILE_DIR]);
  } catch {}
}

async function closeCtx(ctx) {
  await Promise.race([ctx.close().catch(() => {}), sleep(3000)]);
  killStrayBrowsers();
}

async function cleanup() {
  await closeShared();
  killStrayBrowsers();
}

process.on('exit', killStrayBrowsers);
process.on('SIGTERM', () => cleanup().finally(() => process.exit(0)));
process.on('SIGINT', () => cleanup().finally(() => process.exit(0)));

if (process.argv.includes('--self-test')) {
  // 端到端验证：登录判定 + UI 搜索全链路（与 MCP 工具调用同一路径）。
  // 追加 --skip 可跳过登录检查，用于诊断签名/风控链路；--chats 验证私信会话列表；
  // --chat-notes=<id> 验证指定会话中分享的笔记。
  const argv = process.argv;
  if (argv.includes('--chats')) {
    const r = await listChats().catch((e) => ({ error: String(e) }));
    console.log(JSON.stringify(r, null, 2));
  } else if (argv.some((a) => a.startsWith('--chat-notes='))) {
    const id = argv.find((a) => a.startsWith('--chat-notes=')).split('=')[1];
    const r = await getChatNotes(id, 10).catch((e) => ({ error: String(e) }));
    console.log(JSON.stringify(r, null, 2));
  } else {
    const skip = argv.includes('--skip');
    const r = await doSearch('杭州天气', 5, { skipLoginCheck: skip }).catch((e) => ({
      error: String(e),
    }));
    console.log(JSON.stringify(r, null, 2));
  }
  await cleanup();
  process.exit(0);
}

const transport = new StdioServerTransport();
transport.onclose = () => {
  // 客户端断开（重启/退出）时杀掉浏览器子进程，避免进程残留
  const hard = setTimeout(() => process.exit(0), 5000);
  cleanup().finally(() => {
    clearTimeout(hard);
    process.exit(0);
  });
};
await server.connect(transport);
console.error(`[xhs] xiaohongshu-mcp ready (headless=${HEADLESS}, profile=${PROFILE_DIR})`);
