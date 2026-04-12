# OpenClaw Browser Automation

中文 | [English](#english) | [Русский](#русский)

高性能、可扩展的浏览器自动化平台，基于 Chrome DevTools Protocol (CDP)，为 AI Agents 提供稳定的多并发浏览器控制能力。

## 默认语言：中文

### 项目简介

OpenClaw Browser Automation 是一套面向 AI Agent 的浏览器自动化解决方案，主要包含：

- **CDP Service**：独立 CDP 服务，提供高性能 JavaScript 执行、导航和浏览器控制
- **MCP Server**：通过 Model Context Protocol 为 Claude 等模型暴露标准化浏览器工具
- **Chrome Extension**：可选扩展组件（当前未实现，仅作为未来方向说明）

### 核心能力

- **多 Agent 并发稳定性**：独立会话与队列模型，减少 agent 间干扰
- **浏览器所有权与状态分离**：支持 `browserMode: shared | dedicated` 与 `stateMode: profile | fresh`
- **持久 Profile**：`dedicated + profile` 保留 cookies、localStorage、缓存、IndexedDB、Service Worker 与完整 Chrome `user-data-dir`
- **Fresh 实例**：`dedicated + fresh` 用于无状态、隔离的 clean-room 访问
- **Workspace / Global Profile 存储**：支持 `profileScope: workspace | global`
- **Profile 生命周期管理**：支持创建、列举、查询、删除、迁移 profile
- **Outline-first Snapshot**：`browser_snapshot` 默认返回 DOM outline，需要时再展开局部 HTML
- **SPA / 动态页面稳定等待**：`browser_wait(mode: "content-stable")` 适配 Framer、SPA 与长加载页面
- **Iframe 基础探测与同源 frame 操作**：支持 `browser_frames`、`frameIndex` 与 `iframeIndex`；其中 `frameIndex` 选择 document 层级（`0` 为顶层 document），`iframeIndex` 用于直接选择当前顶层页面中的同源 iframe
- **社媒导航默认安全限流**：`browser_navigate` 对 LinkedIn / Instagram / X(Twitter) / Facebook 默认启用站点级 FIFO 排队、最小启动间隔和随机启动延迟
- **生产级可观测性**：Prometheus 指标、结构化日志、可扩展追踪

### 架构概览

```text
AI Agent / Claude
        │
        │ MCP / HTTP
        ▼
   CDP Service
   ├─ Isolation Router
   ├─ Budget Manager
   ├─ Queue Manager
   ├─ Navigation Safety Queue
   └─ CDP Engine Pool
        │
        │ CDP WebSocket
        ▼
  Chrome / Chromium
```

### 快速开始

#### 1. 前置要求

- Node.js 22+
- Chrome / Chromium
- TypeScript 5.1+（开发时）

#### 2. 安装

```bash
git clone git@github.com:CACppuccino/browser-automation.git
cd browser-automation/cdp-service
npm install
npm run build
```

#### 3. 启动 Chrome（调试模式）

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Linux
google-chrome --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

验证 CDP 端点：

```bash
curl http://localhost:9222/json/version
```

#### 4. 启动 CDP Service

```bash
export CDP_SERVICE_TOKEN="your-secret-token-here"
npm start config.yaml

# 高并发场景可使用
npm start config-optimized.yaml
```

服务默认监听：

- `http://localhost:3100`

#### 5. 健康检查

```bash
curl http://localhost:3100/health
```

### 作为 MCP Server 使用

#### Claude Desktop / MCP 配置示例

```json
{
  "mcpServers": {
    "openclaw-browser": {
      "command": "node",
      "args": ["/absolute/path/to/browser-automation/mcp-server/index.js"],
      "env": {
        "CDP_SERVICE_URL": "http://localhost:3100",
        "CDP_SERVICE_TOKEN": "your-secret-token-here"
      }
    }
  }
}
```

### MCP 常用能力

#### 1. 页面导航

```json
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://www.linkedin.com/",
    "agentId": "linkedin-research",
    "browserMode": "dedicated",
    "stateMode": "profile",
    "profileId": "linkedin-main",
    "profileScope": "workspace",
    "workspacePath": "/absolute/path/to/workspace",
    "waitForLoad": true
  }
}
```

返回中会包含限流相关元数据，例如：

- `metadata.rateLimitApplied`
- `metadata.siteBucket`
- `metadata.queueWaitMs`
- `metadata.startupDelayMs`
- `metadata.startedAt`

#### 2. 浏览器执行

```json
{
  "tool": "browser_evaluate",
  "arguments": {
    "agentId": "demo-agent",
    "browserMode": "dedicated",
    "stateMode": "profile",
    "profileId": "demo-profile",
    "profileScope": "workspace",
    "workspacePath": "/absolute/path/to/workspace",
    "expression": "document.title",
    "timeoutMs": 10000
  }
}
```

#### 3. 页面快照

```json
{
  "tool": "browser_snapshot",
  "arguments": {
    "agentId": "snapshot-agent",
    "browserMode": "dedicated",
    "stateMode": "profile",
    "profileId": "snapshot-profile",
    "profileScope": "workspace",
    "workspacePath": "/absolute/path/to/workspace",
    "expandSelector": "main",
    "limit": 120,
    "offset": 0
  }
}
```

#### 4. Profile 管理

支持的工具：

- `browser_profile_create`
- `browser_profile_list`
- `browser_profile_get`
- `browser_profile_delete`
- `browser_profile_migrate`

### 推荐使用规则

- 轻量访问、无需登录态：优先 `shared`
- 登录态、社媒、客户后台：优先 `dedicated + profile`
- 首访验证、clean-room 检查：使用 `dedicated + fresh`
- 同一 workflow 要保持同一浏览器身份时，稳定复用：
  - `agentId`
  - `browserMode`
  - `stateMode`
  - `profileId` / `profileScope` / `workspacePath`
  - `freshInstanceId`（若复用同一 fresh 实例）

### 相关文档

- 项目架构：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- MCP 安装与使用：[`docs/MCP_INSTALLATION.md`](./docs/MCP_INSTALLATION.md)
- CDP Service 详细文档：[`cdp-service/README.md`](./cdp-service/README.md)
- Chrome Extension 文档（规划中，可选）：[`chrome-extension/README.md`](./chrome-extension/README.md)

### 测试与验证

```bash
cd cdp-service
./test-evaluate.sh
./test-monitoring.sh
./test-compatibility.sh
./test-load.sh
./test-comprehensive.sh
```

### 安全建议

- 使用强随机 token
- 生产环境通过 HTTPS / 反向代理暴露服务
- 仅在受控网络中开放 CDP Service
- 使用非 root 用户运行服务
- 定期更新依赖与 Chrome 版本

### 许可证

MIT License

---

## English

OpenClaw Browser Automation is a high-performance browser automation platform built on Chrome DevTools Protocol (CDP) for reliable multi-agent browser control.

### What it includes

- **CDP Service** for browser control, navigation, and JavaScript execution
- **MCP Server** for exposing browser tools to Claude and other MCP clients
- **Chrome Extension** as an optional browser-side component

### Key features

- Stable multi-agent concurrency
- Separate browser ownership and browser state models
- Persistent profiles with full Chrome `user-data-dir`
- Fresh isolated browser instances
- Workspace-scoped and global profile storage
- Profile lifecycle operations (create/list/get/delete/migrate)
- Outline-first snapshots with selective HTML expansion
- SPA-friendly stable waiting via `browser_wait(mode: "content-stable")`
- Same-origin iframe inspection and frame/document targeting via `browser_frames`, `frameIndex`, and `iframeIndex`; `frameIndex` selects document levels (`0` is the top-level document), while `iframeIndex` directly selects same-origin iframes under the current top-level document
- Default social-site navigation safety throttling for LinkedIn, Instagram, X/Twitter, and Facebook
- Production-oriented observability and metrics

### Quick start

```bash
git clone git@github.com:CACppuccino/browser-automation.git
cd browser-automation/cdp-service
npm install
npm run build
export CDP_SERVICE_TOKEN="your-secret-token-here"
npm start config.yaml
```

Start Chrome with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

Health check:

```bash
curl http://localhost:3100/health
```

### MCP example

```json
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://www.linkedin.com/",
    "agentId": "linkedin-research",
    "browserMode": "dedicated",
    "stateMode": "profile",
    "profileId": "linkedin-main",
    "profileScope": "workspace",
    "workspacePath": "/absolute/path/to/workspace"
  }
}
```

Navigation responses may include:

- `metadata.rateLimitApplied`
- `metadata.siteBucket`
- `metadata.queueWaitMs`
- `metadata.startupDelayMs`
- `metadata.startedAt`

### Documentation

- Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- MCP installation and usage: [`docs/MCP_INSTALLATION.md`](./docs/MCP_INSTALLATION.md)
- CDP Service details: [`cdp-service/README.md`](./cdp-service/README.md)
- Chrome Extension: [`chrome-extension/README.md`](./chrome-extension/README.md)

### License

MIT License

---

## Русский

OpenClaw Browser Automation — это высокопроизводительная платформа автоматизации браузера на базе Chrome DevTools Protocol (CDP), предназначенная для стабильной многопоточной работы AI-агентов.

### Что входит в проект

- **CDP Service** для навигации, управления браузером и выполнения JavaScript
- **MCP Server** для предоставления браузерных инструментов Claude и другим MCP-клиентам
- **Chrome Extension** как дополнительный компонент на стороне браузера

### Ключевые возможности

- Стабильная многoагентная параллельная работа
- Разделение модели владения браузером и модели состояния браузера
- Постоянные профили с полным Chrome `user-data-dir`
- Временные изолированные экземпляры браузера
- Хранение профилей в workspace или в глобальной области
- Управление жизненным циклом профилей
- Snapshot в режиме outline-first с выборочным раскрытием HTML
- Стабильное ожидание для SPA через `browser_wait(mode: "content-stable")`
- Работа с same-origin iframe и уровнями документа через `browser_frames`, `frameIndex` и `iframeIndex`; `frameIndex` выбирает уровень документа (`0` — верхний документ), а `iframeIndex` напрямую выбирает same-origin iframe в текущем верхнем документе
- Встроенное защитное ограничение навигации для LinkedIn, Instagram, X/Twitter и Facebook
- Метрики и наблюдаемость для production-сценариев

### Быстрый старт

```bash
git clone git@github.com:CACppuccino/browser-automation.git
cd browser-automation/cdp-service
npm install
npm run build
export CDP_SERVICE_TOKEN="your-secret-token-here"
npm start config.yaml
```

Запустите Chrome с включённым remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

Проверка здоровья сервиса:

```bash
curl http://localhost:3100/health
```

### Пример MCP

```json
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://www.linkedin.com/",
    "agentId": "linkedin-research",
    "browserMode": "dedicated",
    "stateMode": "profile",
    "profileId": "linkedin-main",
    "profileScope": "workspace",
    "workspacePath": "/absolute/path/to/workspace"
  }
}
```

Ответ навигации может содержать:

- `metadata.rateLimitApplied`
- `metadata.siteBucket`
- `metadata.queueWaitMs`
- `metadata.startupDelayMs`
- `metadata.startedAt`

### Документация

- Архитектура: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Установка и использование MCP: [`docs/MCP_INSTALLATION.md`](./docs/MCP_INSTALLATION.md)
- Документация CDP Service: [`cdp-service/README.md`](./cdp-service/README.md)
- Документация Chrome Extension: [`chrome-extension/README.md`](./chrome-extension/README.md)

### Лицензия

MIT License
