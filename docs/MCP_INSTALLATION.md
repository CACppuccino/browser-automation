# MCP Server安装和使用指南

## 什么是MCP？

MCP (Model Context Protocol) 是由Anthropic开发的标准化协议，用于AI模型与外部工具和数据源的交互。它为Claude等大型语言模型提供访问浏览器自动化能力的标准接口。

本项目的 MCP Server 名为 `openclaw-browser`，底层通过 CDP Service 提供浏览器控制、页面读取、DOM 交互、持久 profile 管理与多 agent 并发隔离能力。

## 当前能力概览

### 浏览器所有权模型
- `browserMode: "shared"`：复用外部已存在的 Chrome CDP 端点，适合轻量、多 tab 并发
- `browserMode: "dedicated"`：为 workflow 启动独立 Chrome，适合登录态、隔离性强的任务

### 浏览器状态模型
- `stateMode: "profile"`：持久 profile，保留 cookies、localStorage、缓存、IndexedDB、Service Worker 与完整 Chrome `user-data-dir`
- `stateMode: "fresh"`：全新临时实例，适合 clean-room 验证与无状态访问

### Profile 存储范围
- `profileScope: "workspace"`：默认模式，profile 落在 agent workspace 下
- `profileScope: "global"`：跨 workspace 共享长期浏览器身份

### Profile 生命周期工具
- `browser_profile_create`
- `browser_profile_list`
- `browser_profile_get`
- `browser_profile_delete`
- `browser_profile_migrate`

### Snapshot 输出策略
- `browser_snapshot` 默认返回 **DOM outline**，更节省上下文
- 通过 `expandSelector` 只展开局部 HTML
- 通过 `fullContent: true` 获取整页 HTML
- 通过 `limit` / `offset` 分页读取大页面

### iframe / frameIndex 语义
- `frameIndex` 现在表示 **document 层级**，取值应来自 `browser_frames`
- `frameIndex: 0` 表示顶层 document
- `frameIndex: 1` 表示第一个同源 iframe 的 document，`frameIndex: 2` 表示第二个，以此类推
- `iframeIndex` 表示当前顶层页面中的直接同源 iframe 索引，仅用于兼容直接按 iframe 下标选择的场景
- 同一次调用中只能传 `frameIndex` 或 `iframeIndex` 二选一
- 建议先用 `browser_frames` 查看当前页面可访问 frame，再决定传哪个参数

### 导航安全限流
- `browser_navigate` 现在走服务端显式 `/api/v1/navigate` 接口，而不是通过 `browser_evaluate` 间接跳转
- 对 `linkedin.com`、`instagram.com`、`x.com` / `twitter.com`、`facebook.com` 默认启用站点级安全限流
- 同一站点下，不同 agent 共享同一个 FIFO 队列
- 同站点相邻两次新 URL 导航启动至少间隔 `5s`
- 每次真正开始导航前会再加入 `0~3000ms` 随机启动延迟
- 该默认策略仅作用于 `browser_navigate`，不会拦截 `browser_evaluate` 中手写的 `window.location` 跳转
- `browser_navigate` 返回值中会附带 `metadata.rateLimitApplied`、`metadata.siteBucket`、`metadata.queueWaitMs`、`metadata.startupDelayMs`、`metadata.startedAt`

## 安装MCP Server

### 前置要求

1. **CDP Service运行中**
   ```bash
   curl http://localhost:3100/health
   ```

2. **Node.js 22+**
   ```bash
   node --version
   ```

### 安装步骤

```bash
cd browser-automation/mcp-server
npm install

export CDP_SERVICE_URL="http://localhost:3100"
export CDP_SERVICE_TOKEN="your-secret-token"

node index.js
```

## 在Claude Desktop中配置

### 配置文件位置

**macOS**:
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Windows**:
```
%APPDATA%\Claude\claude_desktop_config.json
```

**Linux**:
```
~/.config/Claude/claude_desktop_config.json
```

### 配置内容

```json
{
  "mcpServers": {
    "openclaw-browser": {
      "command": "node",
      "args": [
        "/absolute/path/to/browser-automation/mcp-server/index.js"
      ],
      "env": {
        "CDP_SERVICE_URL": "http://localhost:3100",
        "CDP_SERVICE_TOKEN": "your-secret-token-here"
      }
    }
  }
}
```

## MCP工具列表

### 1. `browser_navigate`
导航到指定 URL。

常用参数：
- `url`
- `agentId`
- `browserMode`
- `stateMode`
- `profileId`
- `profileScope`
- `workspacePath`
- `freshInstanceId`
- `waitForLoad`

**示例：workspace 持久 profile**
```json
{
  "url": "https://www.linkedin.com/",
  "agentId": "linkedin-research",
  "browserMode": "dedicated",
  "stateMode": "profile",
  "profileId": "linkedin-main",
  "profileScope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "waitForLoad": true
}
```

**返回元数据示例**：
```json
{
  "url": "https://www.linkedin.com/feed/",
  "title": "Feed | LinkedIn",
  "readyState": "interactive",
  "metadata": {
    "rateLimitApplied": true,
    "siteBucket": "linkedin",
    "queueWaitMs": 5032,
    "startupDelayMs": 1844,
    "startedAt": 1710000000000
  }
}
```

**示例：fresh 实例**
```json
{
  "url": "https://example.com/",
  "agentId": "clean-check",
  "browserMode": "dedicated",
  "stateMode": "fresh",
  "freshInstanceId": "audit-1",
  "waitForLoad": true
}
```

### 2. `browser_evaluate`
在浏览器上下文执行 JavaScript。

**示例**：
```json
{
  "agentId": "linkedin-research",
  "browserMode": "dedicated",
  "stateMode": "profile",
  "profileId": "linkedin-main",
  "profileScope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "expression": "({ title: document.title, cookies: document.cookie })",
  "timeoutMs": 10000,
  "awaitPromise": true
}
```

### 3. `browser_click` / `browser_fill`
与页面元素交互。

**示例**：
```json
{
  "agentId": "portal-login",
  "browserMode": "dedicated",
  "stateMode": "profile",
  "profileId": "customer-portal",
  "profileScope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "selector": "input[type='email']",
  "value": "user@example.com"
}
```

### 4. `browser_snapshot`
获取页面当前状态。

默认返回 DOM outline；若传 `expandSelector` 或 `fullContent`，则返回分页内容窗口。

`frameIndex` 现在用于选择 document 层级：`0` 为顶层 document，`1` 为第一个同源 iframe 的 document。若你只想按顶层页面中的直接 iframe 下标选择，也可改传 `iframeIndex`。

**示例：默认 outline-first**
```json
{
  "agentId": "sales-search",
  "browserMode": "shared",
  "limit": 120,
  "outlineDepth": 4
}
```

**示例：只展开 main 区域**
```json
{
  "agentId": "sales-search",
  "browserMode": "dedicated",
  "stateMode": "profile",
  "profileId": "snapshot-profile",
  "profileScope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "expandSelector": "main",
  "limit": 120,
  "offset": 0,
  "includeCookies": true
}
```

### 5. `browser_wait`
等待元素出现或条件满足。

**示例**：
```json
{
  "agentId": "login-flow",
  "browserMode": "dedicated",
  "stateMode": "profile",
  "profileId": "customer-portal",
  "profileScope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "condition": "document.readyState === 'complete' && window.location.pathname !== '/login'",
  "timeoutMs": 15000
}
```

### 6. `browser_health`
检查 CDP Service 健康状态。

### 7. Profile 管理工具

#### `browser_profile_create`
创建持久 profile。

```json
{
  "profileId": "linkedin-main",
  "scope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "displayName": "LinkedIn Main Account"
}
```

#### `browser_profile_list`
列出 profile。

```json
{
  "scope": "workspace",
  "workspacePath": "/absolute/path/to/workspace"
}
```

#### `browser_profile_get`
获取单个 profile 元数据。

#### `browser_profile_delete`
删除未被占用的 profile。

#### `browser_profile_migrate`
在 workspace/global 之间复制或迁移 profile。

```json
{
  "profileId": "linkedin-main",
  "scope": "workspace",
  "workspacePath": "/absolute/path/to/workspace",
  "targetProfileId": "linkedin-main-global",
  "targetScope": "global",
  "mode": "copy"
}
```

## 使用建议

### 何时使用 `shared`
- 轻量网页浏览
- 多 agent 并发开 tab
- 不依赖持久登录态

### 何时使用 `dedicated + profile`
- LinkedIn / Gmail / X / 社交网站
- 客户门户、后台、登录后工作流
- 任何需要保留浏览器身份与缓存的场景

### 何时使用 `dedicated + fresh`
- 首访验证
- clean-room 测试
- 不希望带入任何旧状态的访问

### 参数稳定性规则
同一 workflow 若想保持同一浏览器状态，必须稳定复用：
- `agentId`
- `browserMode`
- `stateMode`
- `profileId` / `profileScope` / `workspacePath`（持久 profile 场景）
- `freshInstanceId`（需要复用同一个 fresh 实例时）

## 故障排查

### `shared + fresh` 报错
这是预期行为，`shared` 不支持 `stateMode: "fresh"`。

### `workspace` profile 缺少 `workspacePath`
这是预期行为，`profileScope: "workspace"` 时必须传绝对路径 `workspacePath`。

### 页面状态丢失
常见原因：
- 切换了 `agentId`
- 切换了 `browserMode`
- 切换了 `stateMode`
- 持久 profile 参数不一致
- 本该用 `profile` 却用了 `fresh`

### Snapshot 返回内容太多或太少
优先使用：
- 默认 outline-first
- `expandSelector` 精准展开
- `limit` / `offset` 分页
- 仅在确实需要时再用 `fullContent: true`

## 安全建议

1. **保护认证令牌**
   - 不要在配置文件中硬编码令牌
   - 使用环境变量或密钥管理服务

2. **限制访问**
   - CDP Service仅监听localhost
   - 使用防火墙限制访问

3. **审计日志**
   - 启用CDP Service的日志记录
   - 定期审查操作日志

4. **资源限制**
   - 配置合理的超时时间
   - 限制并发请求数量

5. **服务侧请求日志**
   - CDP Service 现在会记录每次 HTTP 请求的 method、path、query 和脱敏后的 body
   - evaluate / navigate 失败时会额外记录错误日志，便于排查入参与运行时异常

## 参考资源

- [MCP官方文档](https://modelcontextprotocol.io/)
- [Claude Desktop配置指南](https://docs.anthropic.com/claude/docs/claude-desktop)
- [CDP Service API文档](../cdp-service/README.md)
