# OpenClaw CDP Service

独立的Chrome DevTools Protocol (CDP) 服务，为OpenClaw提供高性能、可扩展的浏览器自动化能力。

## 概述

CDP服务解决了OpenClaw在多agent并发、操作阻塞和监控缺失等方面的核心问题，提供：

- ✅ **多Agent并发稳定性** - 独立CDP会话池，避免agent间相互干扰
- ✅ **解决阻塞问题** - 独立evaluate引擎，避免Playwright队列阻塞
- ✅ **完整监控能力** - Prometheus指标、分布式追踪、结构化日志
- ✅ **向后兼容** - 现有API无缝升级，支持渐进式迁移
- ✅ **生产就绪** - 经过负载测试，支持99%+成功率

## 快速开始

### 前置要求

- Node.js 22+
- Chrome/Chromium浏览器（CDP端点）
- TypeScript 5.1+

### 安装

```bash
# 克隆或导航到CDP服务目录
cd cdp-service

# 安装依赖
npm install

# 构建TypeScript
npm run build
```

### 启动服务

```bash
# 设置认证令牌
export CDP_SERVICE_TOKEN="your-secret-token"

# 启动Chrome（如果还没有运行，默认推荐有头模式）
chromium --remote-debugging-port=9222

# 如需无头模式，可显式开启
# chromium --remote-debugging-port=9222 --headless

# 启动CDP服务
npm start config.yaml
```

服务将在 `http://localhost:3100` 启动。

### 验证服务

```bash
# 健康检查
curl http://localhost:3100/health

# 应返回：
{
  "status": "healthy",
  "uptime": 12345,
  "activeEngines": 0,
  "activeSessions": 0,
  "cdpConnections": [
    {
      "url": "http://localhost:9222",
      "status": "connected"
    }
  ]
}
```

### 浏览器模式说明

#### 浏览器所有权
- `shared` 模式复用你提供的 CDP Chrome（例如 `http://localhost:9222`）
- `dedicated` 模式为每个 agent 启动独立 Chrome 实例

#### 浏览器状态模型
- `stateMode: "profile"`：使用持久 profile，保留 cookies、localStorage、缓存、IndexedDB、Service Worker 与完整 Chrome `user-data-dir`
- `stateMode: "fresh"`：使用一次性临时实例，适合 clean-room 访问与无状态验证

#### Profile 存储范围
- `profileScope: "workspace"`：默认模式，profile 存储在 `<workspacePath>/.browser-automation/profiles/<profileId>/`
- `profileScope: "global"`：profile 存储在全局目录，适合跨 workspace 复用长期浏览器身份

#### 关键规则
- `shared` 不支持 `stateMode: "fresh"`
- `shared` 不支持显式选择 `profileId`
- `dedicated + profile` 需要 `profileId`
- `profileScope: "workspace"` 时需要绝对路径 `workspacePath`
- `browser.dedicated.headless` 控制 dedicated 实例是否无头运行
- 默认配置现在是 `headless: false`，也就是有头模式，便于观察执行过程并降低部分站点对无头浏览器的风控命中率
- 如需恢复无头模式，把 `config.yaml` 或 `config-optimized.yaml` 中的 `browser.dedicated.headless` 改为 `true`
- `browser_navigate` 现在使用显式 `/api/v1/navigate`，并可对受保护社媒站点启用默认安全限流

#### 社媒导航安全限流
- 默认受保护站点：`linkedin.com`、`instagram.com`、`x.com` / `twitter.com`、`facebook.com`
- 仅对 `browser_navigate` / `/api/v1/navigate` 生效，不影响 `browser_evaluate` 中手写导航
- 同站点跨 agent 共享一个 FIFO 队列
- 相邻两次新 URL 启动至少间隔 `5s`
- 每次真正开始导航前额外增加 `0~3000ms` 随机延迟
- 可通过 `browser.navigationSafety` 配置关闭或调节策略

## 核心功能

### 1. JavaScript执行 (Evaluate)

```bash
curl -X POST http://localhost:3100/api/v1/evaluate \
  -H "Authorization: Bearer $CDP_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "expression": "document.title",
    "budget": {
      "timeoutMs": 5000
    }
  }'
```

响应：
```json
{
  "result": "Example Domain",
  "metadata": {
    "durationMs": 45,
    "isolationLevel": "context",
    "engineId": "context-my-agent-1234567890"
  }
}
```

### 2. 隔离策略

CDP服务支持三级隔离：

- **Process级** - 独立Worker进程（最强隔离，适用于不可信代码）
- **Context级** - 独立BrowserContext（推荐，隔离cookie/storage）
- **Session级** - 独立CDP Session（轻量级，共享状态）

隔离策略自动选择或通过配置规则指定：

```yaml
isolation:
  strategy: dynamic  # 或 static
  default: context
  rules:
    - pattern: "heavy-.*"
      level: process
    - pattern: "light-.*"
      level: session
```

### 3. 监控与可观测性

#### Prometheus指标

```bash
# 查看指标
curl http://localhost:3100/metrics

# 关键指标：
# - cdp_evaluate_total - 请求总数
# - cdp_evaluate_duration_ms - 延迟分布
# - cdp_active_connections - 活跃连接数
# - cdp_errors_total - 错误计数
```

#### 统计API

```bash
# 服务整体统计
curl http://localhost:3100/api/v1/stats \
  -H "Authorization: Bearer $CDP_SERVICE_TOKEN"

# 响应：
{
  "uptime": 3600000,
  "totalRequests": 1234,
  "successRequests": 1200,
  "errorRequests": 34,
  "avgDurationMs": 123.45,
  "requestsPerSecond": 0.34
}
```

## 配置

### 基础配置 (config.yaml)

```yaml
service:
  host: 127.0.0.1
  port: 3100
  authToken: ${CDP_SERVICE_TOKEN}

cdp:
  endpoints:
    - url: http://localhost:9222

browser:
  defaultMode: shared
  shared:
    cdpUrl: http://localhost:9222
  dedicated:
    enabled: true
    executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    host: 127.0.0.1
    startingPort: 9230
    maxInstances: 10
    idleTimeoutMs: 300000
    startupTimeoutMs: 15000
    headless: false
    userDataDirBase: /tmp/browser-automation-sessions
    extraArgs: []
  profiles:
    workspaceRootName: .browser-automation/profiles
    globalRootDir: /tmp/browser-automation-profiles
    defaultScope: workspace
    metadataFileName: profile.json
    lockFileName: lock
    lockTimeoutMs: 30000
    retention:
      keepWorkspaceProfiles: true
      keepGlobalProfiles: true
      cleanupFreshOnShutdown: true
      cleanupFreshOnIdle: true
    migration:
      tempDir: /tmp/browser-automation-profile-migrations
  target:
    createUrl: about:blank
    enforceOwnership: true
    allowClientTargetOverride: false
  navigationSafety:
    enabled: true
    protectedSites:
      - linkedin.com
      - instagram.com
      - x.com
      - twitter.com
      - facebook.com
    minStartIntervalMs: 5000
    maxRandomStartupDelayMs: 3000
    queueDiscipline: fifo
  cleanupIntervalMs: 30000

isolation:
  strategy: dynamic
  default: context

timeouts:
  defaultBudgetMs: 30000
  maxBudgetMs: 120000

monitoring:
  metricsPort: 3101
  logLevel: info
  enableTracing: false
```

### 高性能配置 (config-optimized.yaml)

适用于50+并发agent场景：

```yaml
service:
  host: 127.0.0.1
  port: 3100
  authToken: ${CDP_SERVICE_TOKEN}

cdp:
  endpoints:
    - url: http://localhost:9222
  connectionPool:
    maxPerEndpoint: 100
    minIdleConnections: 10
    connectTimeoutMs: 10000
    maxRetries: 3

browser:
  defaultMode: shared
  shared:
    cdpUrl: http://localhost:9222
  dedicated:
    enabled: true
    executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    host: 127.0.0.1
    startingPort: 9230
    maxInstances: 10
    idleTimeoutMs: 300000
    startupTimeoutMs: 15000
    headless: false
    userDataDirBase: /tmp/browser-automation-sessions
    extraArgs: []
  target:
    createUrl: about:blank
    enforceOwnership: true
    allowClientTargetOverride: false
  navigationSafety:
    enabled: true
    protectedSites:
      - linkedin.com
      - instagram.com
      - x.com
      - twitter.com
      - facebook.com
    minStartIntervalMs: 5000
    maxRandomStartupDelayMs: 3000
    queueDiscipline: fifo
  cleanupIntervalMs: 30000

isolation:
  strategy: dynamic
  default: context
  thresholds:
    highLoadSessionCount: 50
    highLoadCpuPercent: 80
    highLoadMemoryPercent: 85

limits:
  maxConcurrentEvaluations: 100
  maxQueueSize: 500
  enginePoolSize:
    process: 20
    context: 50
    session: 100
```

## 集成到OpenClaw

### 使用客户端库

```typescript
import { CdpServiceClient } from './cdp-service/dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
  defaultTimeout: 30000,
});

const result = await client.evaluate({
  agentId: 'my-agent',
  browserMode: 'dedicated',
  stateMode: 'profile',
  profileId: 'linkedin-main',
  profileScope: 'workspace',
  workspacePath: '/absolute/path/to/workspace',
  expression: 'document.title',
  budget: { timeoutMs: 5000 }
});
```

### 使用适配器（推荐）

参见 `examples/integration-adapter.ts` 了解完整的集成示例，包含自动降级到legacy实现。

## 性能基准

### 当前性能（优化后配置）

| 并发级别 | 成功率 | 吞吐量 | P95延迟 |
|----------|--------|--------|---------|
| 20 agents | 99.99% | 251 req/s | <800ms |
| 50 agents | 97.4% | 60 req/s | 999ms |

### 测试负载

```bash
# 运行完整负载测试
./test-load.sh

# 测试包括：
# - 基准性能（顺序）
# - 并发负载（50 agents × 10 requests）
# - 持续负载（30秒）
# - 突发压力（100并发）
```

## API参考

### POST /api/v1/evaluate

执行JavaScript代码评估。需要认证。

**请求**：
```json
{
  "agentId": "string (可选)",
  "targetId": "string (可选)",
  "expression": "string (必需)",
  "awaitPromise": "boolean (可选)",
  "returnByValue": "boolean (可选)",
  "budget": {
    "timeoutMs": "number (必需)"
  }
}
```

**响应**：
```json
{
  "result": "any",
  "metadata": {
    "durationMs": "number",
    "isolationLevel": "process|context|session",
    "engineId": "string"
  }
}
```

### POST /api/v1/navigate

执行显式页面导航。需要认证。

**请求**：
```json
{
  "agentId": "string (可选)",
  "url": "string (必需，绝对 URL)",
  "browserMode": "shared|dedicated (可选)",
  "stateMode": "profile|fresh (可选)",
  "profileId": "string (可选)",
  "profileScope": "workspace|global (可选)",
  "workspacePath": "string (workspace profile 时必需)",
  "freshInstanceId": "string (可选)",
  "waitForLoad": "boolean (可选)",
  "timeoutMs": "number (可选)"
}
```

**响应**：
```json
{
  "url": "https://www.linkedin.com/feed/",
  "title": "Feed | LinkedIn",
  "readyState": "interactive",
  "metadata": {
    "browserMode": "dedicated",
    "stateMode": "profile",
    "browserInstanceId": "browser-123",
    "targetId": "target-123",
    "rateLimitApplied": true,
    "siteBucket": "linkedin",
    "queueWaitMs": 5032,
    "startupDelayMs": 1844,
    "startedAt": 1710000000000
  }
}
```

### GET /health

健康检查端点（无需认证）。

**响应**：
```json
{
  "status": "healthy|degraded|unhealthy",
  "uptime": "number",
  "activeEngines": "number",
  "activeSessions": "number",
  "cdpConnections": [
    {
      "url": "string",
      "status": "connected|disconnected"
    }
  ]
}
```

### GET /metrics

Prometheus指标端点（无需认证）。

返回文本格式的Prometheus指标。

### GET /api/v1/stats

服务统计信息。需要认证。

### GET /api/v1/stats/engines

所有引擎统计信息。需要认证。

### GET /api/v1/stats/agents/:id

特定agent的统计信息。需要认证。

## 开发

### 本地开发

```bash
# 安装依赖
npm install

# 开发模式（自动重启）
npm run dev

# 构建
npm run build

# 运行测试
./test-comprehensive.sh
```

### 测试套件

- `test-evaluate.sh` - 基础evaluate功能测试
- `test-monitoring.sh` - 监控功能测试
- `test-compatibility.sh` - 兼容性测试
- `test-load.sh` - 负载性能测试
- `test-comprehensive.sh` - 完整测试套件

### 代码结构

```
cdp-service/
├── src/
│   ├── index.ts              # 服务入口
│   ├── service-manager.ts    # 生命周期管理
│   ├── http-server.ts        # HTTP/WS服务器
│   ├── cdp-engine.ts         # CDP评估引擎
│   ├── isolation-router.ts   # 隔离策略路由
│   ├── isolation/
│   │   ├── process.ts        # 进程级隔离
│   │   ├── context.ts        # Context级隔离
│   │   └── session.ts        # Session级隔离
│   ├── budget-manager.ts     # 超时预算管理
│   ├── queue-manager.ts      # 请求队列
│   ├── metrics.ts            # Prometheus指标
│   ├── stats.ts              # 统计收集
│   ├── tracing.ts            # OpenTelemetry追踪
│   ├── logger.ts             # 结构化日志
│   └── client.ts             # HTTP客户端库
├── examples/
│   └── integration-adapter.ts # 集成适配器示例
├── dashboards/
│   └── grafana.json          # Grafana仪表板
├── config.yaml               # 默认配置
├── config-optimized.yaml     # 高性能配置
├── PHASE1_REPORT.md          # Phase 1 完成报告
├── PHASE2_REPORT.md          # Phase 2 完成报告
├── PHASE3_REPORT.md          # Phase 3 完成报告
├── PHASE4_REPORT.md          # Phase 4 完成报告
├── PHASE5_REPORT.md          # Phase 5 完成报告
├── PERFORMANCE_ANALYSIS.md   # 性能分析报告
└── README.md                 # 本文档
```

## 部署

### SystemD服务

```ini
# /etc/systemd/system/cdp-service.service
[Unit]
Description=OpenClaw CDP Service
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/openclaw/cdp-service
Environment="CDP_SERVICE_TOKEN=your-secret-token"
ExecStart=/usr/bin/node dist/index.js config-optimized.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable cdp-service
sudo systemctl start cdp-service
sudo systemctl status cdp-service
```

### Docker部署

```dockerfile
# Dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist/ ./dist/
COPY config.yaml ./

ENV CDP_SERVICE_TOKEN=""
EXPOSE 3100

CMD ["node", "dist/index.js", "config.yaml"]
```

构建和运行：
```bash
docker build -t openclaw-cdp-service .
docker run -d -p 3100:3100 \
  -e CDP_SERVICE_TOKEN=your-token \
  --name cdp-service \
  openclaw-cdp-service
```

## 监控告警

### Prometheus告警规则

```yaml
groups:
  - name: cdp_service
    rules:
      - alert: CDPSuccessRateLow
        expr: rate(cdp_evaluate_total{status="success"}[5m]) < 0.95
        annotations:
          summary: "CDP服务成功率低于95%"

      - alert: CDPLatencyHigh
        expr: histogram_quantile(0.95, cdp_evaluate_duration_ms_bucket) > 2000
        annotations:
          summary: "CDP服务P95延迟超过2秒"

      - alert: CDPConnectionPoolExhausted
        expr: cdp_active_connections > 80
        annotations:
          summary: "CDP连接池接近上限"
```

### Grafana仪表板

导入 `dashboards/grafana.json` 以查看：
- 请求速率和成功率
- 延迟分布（P50/P95/P99）
- 活跃连接和会话数
- 错误率分析

## 故障排查

### 服务无法启动

```bash
# 1. 检查Chrome CDP端点
curl http://localhost:9222/json/version

# 2. 检查端口占用
lsof -i :3100

# 3. 查看日志
tail -f cdp-service.log
```

### 连接失败

**症状**：`fetch failed` 错误

**原因**：连接池耗尽或Chrome不可达

**解决**：使用 `config-optimized.yaml` 或增加连接池限制

### 超时频繁

**症状**：大量timeout错误

**原因**：预算时间过短或系统负载高

**解决**：增加 `defaultBudgetMs` 或优化系统性能

## 项目状态

### 已完成阶段

- ✅ **Phase 1**: 基础设施 - 服务生命周期、HTTP/WS服务器、健康检查
- ✅ **Phase 2**: CDP引擎与隔离 - 独立evaluate引擎、三级隔离策略
- ✅ **Phase 3**: 监控与可观测性 - Prometheus、OpenTelemetry、Stats API
- ✅ **Phase 4**: 集成与兼容性 - 客户端库、适配器、降级机制
- ✅ **Phase 5**: 负载测试与优化 - 性能基准、瓶颈分析、配置优化
- ✅ **Phase 7**: 文档完善 - 完整README、用户指南、运维文档

### 可选后续工作

- ⚪ **Phase 6**: 渐进式生产发布（2-3周含观察期）
- ⚪ **Phase 5B**: WebSocket连接池（推荐，2-3天工作量）

### 生产就绪评估

**当前状态（优化配置）**：
- ✅ **<30 agents**: 99%+ 成功率，生产就绪
- ⚠️  **30-50 agents**: 97-98% 成功率，可用但需监控
- 🔴 **>50 agents**: <95% 成功率，推荐实施Phase 5B连接池优化

## 安全性

### 认证

所有API端点（除了`/health`和`/metrics`）需要Bearer token认证：

```bash
curl -H "Authorization: Bearer $CDP_SERVICE_TOKEN" \
  http://localhost:3100/api/v1/stats
```

### 最佳实践

1. **使用强token** - 至少32字符随机字符串
2. **HTTPS加密** - 生产环境使用反向代理（nginx）配置SSL
3. **网络隔离** - 仅内网访问，不对公网开放
4. **限制权限** - 使用专用用户运行服务，非root
5. **定期更新** - 及时更新依赖和安全补丁

## 许可证

MIT License

## 版本历史

- **v1.0.0** (2026-03-15)
  - ✅ 完整CDP服务实现
  - ✅ 三级隔离策略
  - ✅ Prometheus监控
  - ✅ 负载测试优化
  - ✅ 生产就绪
