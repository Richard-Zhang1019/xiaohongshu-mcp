# xiaohongshu-mcp

小红书（RedNote）MCP server。**扫码登录一次**（Playwright 持久化浏览器 Profile，登录态长期保存），之后 AI 即可在任意会话里直接搜索笔记、读正文、拉评论——适合「搜攻略、对比方案」这类任务。

## 工具

| 工具 | 作用 |
|---|---|
| `login` | 弹出浏览器窗口显示登录二维码，**立即返回**（不阻塞等待扫码）；后台检测登录并自动跑一次搜索验证 |
| `check_login` | 查看登录状态；扫码完成后调用它取回登录与验证结果 |
| `search_notes` | 关键词搜索，返回标题/作者/点赞数/`note_id`/`xsec_token`/链接 |
| `get_note_detail` | 按 `note_id` + `xsec_token` 读笔记正文、互动数据、标签 |
| `get_note_comments` | 拉笔记评论（含楼中楼），攻略类笔记评论区常有重要补充 |
| `list_chats` | 列出私信会话（chat_id、昵称、最后一条消息） |
| `get_chat_notes` | 提取指定会话中**好友分享的笔记**（标题、作者、note_id、xsec_token、分享时间），结果可直接传给 `get_note_detail`（token 配 `xsec_source=app_share`） |

## 安装

要求：Node ≥ 18，本机装有 Google Chrome（或 Edge；都没有则 `npx playwright install chromium`）。

```bash
git clone https://github.com/Richard-Zhang1019/xiaohongshu-mcp.git ~/xiaohongshu-mcp
cd ~/xiaohongshu-mcp
npm install
node index.js --self-test   # 可选：本地自检
```

## 注册到 MCP 客户端

ZCode（`~/.zcode/cli/config.json`）：

```json
{
  "mcp": {
    "servers": {
      "xiaohongshu": {
        "command": "node",
        "args": ["/绝对路径/xiaohongshu-mcp/index.js"]
      }
    }
  }
}
```

Claude Code / 其他兼容 `mcpServers` 格式的客户端同理。

## 使用

1. 对 AI 说「调用 xiaohongshu 的 login」，弹出 Chrome 窗口后用小红书 App 扫码；
2. 扫完后说「check_login」，确认登录成功（后台会自动验证一次搜索链路）；
3. 之后直接说需求，例如：「在小红书分别搜 A 和 B 两个攻略，各读几篇笔记和热评，帮我对比」。

登录态保存在 `~/.xiaohongshu-mcp/browser-profile`；删除该目录即登出。

## 实现要点

- **搜索主路线**：像真人一样在页面搜索框输入提交，拦截页面自己发出的签名 XHR 拿结构化 JSON。这是唯一稳定可靠的路线——外部复刻签名请求（即使 `x-s`/`x-t` 合法）会被网关以 500 "invoker failed" 拒绝，且登录后立刻发这类请求会触发风控、导致 session 快速失效。评论、私信历史同理：都改为拦截页面自己的 XHR。
- **私信**：会话列表来自 `/chat` 页的 `im/web/v3/chats`；会话历史在 `/chat/{id}` 首屏 + 向上滚动触发 `messages/history` 分页；分享笔记消息 `content_type=3`，content 为双层 JSON，内层 `link`（`xhsdiscover://item/{id}?...xsec_token=`）提供 note_id 与 token（App 分享来源，读正文配 `xsec_source=app_share`）。
- 备选路线：页面上下文内 `window._webmsxyw` 签名直调；兜底：搜索结果页 DOM 提取、笔记页 `__INITIAL_STATE__` 提取。
- 笔记正文从笔记页 `__INITIAL_STATE__` **严格按 note_id 索引**提取（map 里会混入相关推荐笔记，不能取第一个 key）。
- **登录判定用页面自证**（搜索框 placeholder），不信 cookie：`web_session` 存在但 session 被服务端失效时所有接口一律 500。判定固定在首页做（等 hydration 完成），结果缓存 5 分钟（同一浏览器实例内不重复判定）。
- **客户端工具超时**：ZCode 等客户端默认 30s，可在 MCP 配置加 `"timeoutMs": 120000`；服务端各等待均已压缩，冷启动路径也能过关；等待扫码的 login 必须异步（弹窗立即返回）。
- 点赞数标准化（"1.2万" → 12000、"999+" → 999）。
- 默认有头模式（工具调用时会短暂弹出 Chrome 窗口，这是不被风控的关键）；设 `XHS_HEADLESS=1` 可切无头。
- 浏览器实例共享复用、空闲 10 分钟自动回收；工具调用串行化；进程退出时 `-9` 强杀浏览器防泄漏。
- 部分设计参考了 [cn-scraper-mcp](https://github.com/goesByhc/cn-scraper-mcp) 的小红书实现，感谢其踩坑经验。

## 诊断

```bash
npm run self-test                      # 端到端：登录判定 + UI 搜索（与 MCP 调用同路径）
node index.js --self-test --chats      # 验证私信会话列表
node index.js --self-test --chat-notes=<chat_id>   # 验证某会话中分享的笔记
```

## License

MIT
