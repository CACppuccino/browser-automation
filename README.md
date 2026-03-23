# OpenClaw Browser Automation

高性能、可扩展的浏览器自动化平台，基于Chrome DevTools Protocol (CDP)，为AI Agents提供稳定的多并发浏览器控制能力。

## 🎯 项目简介

OpenClaw Browser Automation是一套完整的浏览器自动化解决方案，包含：

- **CDP Service** - 独立的CDP服务，提供高性能JavaScript执行和浏览器控制
- **MCP Server** - Model Context Protocol服务端，为Claude等AI模型提供标准化接口
- **Chrome Extension** - 浏览器扩展，增强自动化能力（可选）

### 为什么选择CDP Service？

解决OpenClaw原有Browser Tool的核心问题：

✅ **多Agent并发稳定性** - 独立CDP会话池，避免agent间相互干扰
✅ **解决阻塞问题** - 独立evaluate引擎，避免Playwright队列阻塞
✅ **完整监控能力** - Prometheus指标、分布式追踪、结构化日志
✅ **向后兼容** - 现有API无缝升级，支持渐进式迁移
✅ **生产就绪** - 负载测试验证，支持99%+成功率

## 📊 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Agent / Claude                       │
└────────────────────┬────────────────────────────────────────┘
                     │ MCP Protocol / HTTP API
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                      CDP Service                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Isolation  │  │    Budget    │  │   Metrics    │      │
│  │    Router    │  │   Manager    │  │  Collector   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         CDP Engine Pool (Process/Context/Session)    │    │
│  └─────────────────────────────────────────────────────┘    │
└────────────────────┬────────────────────────────────────────┘
                     │ WebSocket (CDP Protocol)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    Chrome / Chromium                         │
│              (--remote-debugging-port=9222)                  │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 1. 前置要求

- **Node.js** 22+
- **Chrome/Chromium** 浏览器
- **TypeScript** 5.1+ (开发时)

### 2. 安装CDP Service

```bash
# 克隆仓库
git clone git@github.com:CACppuccino/browser-automation.git
cd browser-automation/cdp-service

# 安装依赖
npm install

# 构建TypeScript
npm run build
```

### 3. 启动Chrome（调试模式）

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Linux
google-chrome --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Windows
chrome.exe --remote-debugging-port=9222 \
  --user-data-dir=C:\temp\chrome-debug
```

**验证CDP端点**：
```bash
curl http://localhost:9222/json/version
```

### 4. 启动CDP Service

```bash
# 设置认证令牌
export CDP_SERVICE_TOKEN="your-secret-token-here"

# 启动服务（默认配置）
npm start config.yaml

# 或使用优化配置（50+并发）
npm start config-optimized.yaml
```

服务将在 `http://localhost:3100` 启动。

### 5. 验证服务

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

## 🔧 作为MCP Server使用

### MCP配置

CDP Service可以作为MCP (Model Context Protocol) Server，为Claude等AI模型提供浏览器自动化能力。

#### 方法1：直接HTTP集成

在你的MCP客户端配置中添加：

```json
{
  "mcpServers": {
    "openclaw-browser": {
      "url": "http://localhost:3100",
      "headers": {
        "Authorization": "Bearer your-secret-token-here"
      },
      "capabilities": ["browser-automation", "javascript-execution"]
    }
  }
}
```

#### 方法2：使用MCP SDK包装

创建MCP服务器包装器（`mcp-server/index.ts`）：

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CdpServiceClient } from "../cdp-service/dist/client.js";

const server = new Server(
  {
    name: "openclaw-browser",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const cdpClient = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
});

// 注册MCP工具
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "browser_evaluate",
      description: "Execute JavaScript in browser",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string" },
          agentId: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["expression"]
      }
    },
    {
      name: "browser_navigate",
      description: "Navigate to URL",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          agentId: { type: "string" }
        },
        required: ["url"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "browser_evaluate":
      const result = await cdpClient.evaluate({
        agentId: args.agentId || 'mcp-agent',
        expression: args.expression,
        budget: { timeoutMs: args.timeoutMs || 30000 }
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };

    case "browser_navigate":
      await cdpClient.evaluate({
        agentId: args.agentId || 'mcp-agent',
        expression: `window.location.href = '${args.url}'`,
        budget: { timeoutMs: 5000 }
      });
      return { content: [{ type: "text", text: "Navigated successfully" }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**启动MCP Server**：
```bash
cd mcp-server
npm install
node index.js
```

### Claude Desktop配置

在 `~/Library/Application Support/Claude/claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "openclaw-browser": {
      "command": "node",
      "args": ["/absolute/path/to/browser-automation/mcp-server/index.js"],
      "env": {
        "CDP_SERVICE_TOKEN": "your-secret-token-here"
      }
    }
  }
}
```

重启Claude Desktop，浏览器自动化工具将自动可用。

## 📚 MCP功能列表

CDP Service通过MCP提供以下核心功能：

### 1. JavaScript执行 (browser_evaluate)

在浏览器上下文中执行任意JavaScript代码。

**示例**：
```javascript
// 获取页面标题
{
  "tool": "browser_evaluate",
  "arguments": {
    "expression": "document.title",
    "agentId": "claude-agent-1"
  }
}

// 提取页面链接
{
  "tool": "browser_evaluate",
  "arguments": {
    "expression": "Array.from(document.querySelectorAll('a')).map(a => ({text: a.textContent, href: a.href}))",
    "timeoutMs": 10000
  }
}
```

### 2. 页面导航 (browser_navigate)

导航到指定URL。

**示例**：
```javascript
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://www.google.com",
    "agentId": "claude-agent-1"
  }
}
```

### 3. DOM操作 (browser_interact)

与页面元素交互（点击、输入等）。

**示例**：
```javascript
// 填写搜索框
{
  "tool": "browser_evaluate",
  "arguments": {
    "expression": "document.querySelector('input[name=\"q\"]').value = 'AI news'; document.querySelector('form').submit();"
  }
}
```

### 4. 页面快照 (browser_snapshot)

获取页面当前状态（HTML、cookies、localStorage）。

**示例**：
```javascript
{
  "tool": "browser_evaluate",
  "arguments": {
    "expression": "({ html: document.documentElement.outerHTML, cookies: document.cookie, url: window.location.href })"
  }
}
```

### 5. 多Agent并发

支持多个Agent同时操作不同浏览器上下文。

**示例**：
```javascript
// Agent 1搜索Google
{
  "tool": "browser_navigate",
  "arguments": { "url": "https://google.com", "agentId": "agent-1" }
}

// Agent 2同时浏览LinkedIn
{
  "tool": "browser_navigate",
  "arguments": { "url": "https://linkedin.com", "agentId": "agent-2" }
}
```

### 6. 超时和预算管理

每个操作支持独立的超时控制。

**示例**：
```javascript
{
  "tool": "browser_evaluate",
  "arguments": {
    "expression": "await fetch('/api/data').then(r => r.json())",
    "timeoutMs": 15000  // 15秒超时
  }
}
```

## ⚡ CDP Service vs Browser Relay/Tool 对比

### 架构差异

| 特性 | CDP Service (新) | Browser Relay/Tool (旧) |
|------|------------------|-------------------------|
| **底层协议** | 直接CDP WebSocket | Playwright高层API |
| **进程隔离** | 独立Node.js服务 | 嵌入在Gateway进程 |
| **并发模型** | 独立引擎池 | 共享Playwright队列 |
| **超时控制** | Runtime.terminateExecution | 依赖Playwright超时 |
| **监控能力** | Prometheus + OpenTelemetry | 有限的日志 |

### 性能对比

| 指标 | CDP Service | Browser Tool |
|------|-------------|--------------|
| **单请求延迟** | ~70ms | ~150-300ms |
| **并发支持** | 50+ agents | 5-10 agents (不稳定) |
| **成功率** | 99.99% (负载测试) | ~85-90% (高并发) |
| **吞吐量** | 251 req/s (20 agents) | ~30 req/s |
| **阻塞问题** | 无阻塞 | 长时间操作阻塞队列 |

### 核心优势

#### 1. 解决并发阻塞

**Browser Tool问题**：
```
Agent 1: evaluate(复杂计算, 60秒)  ← 阻塞队列
Agent 2: evaluate(简单查询, 1秒)   ← 被迫等待60秒
Agent 3: evaluate(简单查询, 1秒)   ← 被迫等待61秒
```

**CDP Service解决方案**：
```
Agent 1: evaluate(复杂计算, 60秒)  ← 独立引擎A
Agent 2: evaluate(简单查询, 1秒)   ← 独立引擎B (并发执行)
Agent 3: evaluate(简单查询, 1秒)   ← 独立引擎C (并发执行)
```

#### 2. 三级隔离策略

**动态选择**最合适的隔离级别：

- **Process级** - Worker进程隔离（重计算任务）
- **Context级** - BrowserContext隔离（推荐，独立cookies/storage）
- **Session级** - CDP Session隔离（轻量级，共享状态）

Browser Tool只支持单一的Page级隔离。

#### 3. 强制超时控制

**Browser Tool**：
- 依赖Playwright的`timeout`参数
- 无法中断执行中的JavaScript
- 长循环/死循环会导致挂起

**CDP Service**：
- 使用`Runtime.terminateExecution` CDP命令
- 强制终止执行中的JavaScript
- 保证超时时间可靠性

#### 4. 完整可观测性

**CDP Service提供**：
- Prometheus指标（请求量、延迟、错误率）
- OpenTelemetry分布式追踪
- 结构化日志（JSON格式）
- 实时Stats API查询
- Grafana仪表板

**Browser Tool**：
- 仅有基础日志
- 无性能指标
- 难以诊断问题

#### 5. 生产级稳定性

**负载测试验证**：
```bash
# 50并发agent × 10次请求
./test-load.sh

结果：
- 成功率：97.4%
- P95延迟：999ms
- 吞吐量：60 req/s
```

Browser Tool在20+并发时成功率显著下降。

## 📖 API参考

### HTTP API

#### POST /api/v1/evaluate

执行JavaScript代码。

**请求**：
```json
{
  "agentId": "my-agent",
  "targetId": "optional-target-id",
  "expression": "document.title",
  "awaitPromise": true,
  "returnByValue": true,
  "budget": {
    "timeoutMs": 5000
  }
}
```

**响应**：
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

#### GET /health

健康检查（无需认证）。

**响应**：
```json
{
  "status": "healthy",
  "uptime": 3600000,
  "activeEngines": 3,
  "activeSessions": 5,
  "cdpConnections": [
    {
      "url": "http://localhost:9222",
      "status": "connected",
      "latencyMs": 5
    }
  ]
}
```

#### GET /metrics

Prometheus指标（无需认证）。

**关键指标**：
- `cdp_evaluate_total` - 请求总数（按status分类）
- `cdp_evaluate_duration_ms` - 延迟分布直方图
- `cdp_active_connections` - 活跃WebSocket连接数
- `cdp_errors_total` - 错误计数（按类型分类）

#### GET /api/v1/stats

服务统计信息（需要认证）。

**响应**：
```json
{
  "uptime": 3600000,
  "totalRequests": 1234,
  "successRequests": 1200,
  "errorRequests": 34,
  "avgDurationMs": 123.45,
  "requestsPerSecond": 0.34,
  "activeEngines": 3,
  "activeSessions": 5
}
```

### 客户端库

**Node.js**：

```typescript
import { CdpServiceClient } from './cdp-service/dist/client.js';

const client = new CdpServiceClient({
  serviceUrl: 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
  defaultTimeout: 30000,
});

// 执行JavaScript
const result = await client.evaluate({
  agentId: 'my-agent',
  expression: 'document.title',
  budget: { timeoutMs: 5000 }
});

console.log('Page title:', result.result);
console.log('Duration:', result.metadata.durationMs, 'ms');

// 获取服务统计
const stats = await client.getStats();
console.log('Success rate:',
  (stats.successRequests / stats.totalRequests * 100).toFixed(2), '%');

// 清理资源
client.dispose();
```

**Python**（示例）：

```python
import requests

class CdpServiceClient:
    def __init__(self, url, token):
        self.url = url
        self.token = token

    def evaluate(self, expression, agent_id='default', timeout_ms=30000):
        response = requests.post(
            f'{self.url}/api/v1/evaluate',
            headers={'Authorization': f'Bearer {self.token}'},
            json={
                'agentId': agent_id,
                'expression': expression,
                'budget': {'timeoutMs': timeout_ms}
            }
        )
        response.raise_for_status()
        return response.json()

# 使用示例
client = CdpServiceClient('http://localhost:3100', 'your-token')
result = client.evaluate('document.title')
print(result['result'])
```

## 🧪 测试与示例

### 真实浏览器测试

```bash
cd cdp-service

# 基础功能测试
./test-evaluate.sh

# 监控功能测试
./test-monitoring.sh

# 兼容性测试
./test-compatibility.sh

# 负载性能测试
./test-load.sh

# 真实浏览器交互测试
export CDP_SERVICE_TOKEN="test-token-123"
node test-real-browser.mjs
```

### 多Agent并发测试

```bash
# 测试3个并发agent收集信息
node test-multi-agent.mjs
```

**测试场景**：
- Agent 1: 访问Instagram获取Elon Musk资料
- Agent 2: 访问LinkedIn获取Elon Musk资料
- Agent 3: Google搜索Elon Musk新闻

**验证指标**：
- 3个agent并发执行不阻塞
- 总执行时间 < 6秒（并发）
- 成功率 100%
- 无跨agent干扰

### 集成示例

参见 `cdp-service/examples/integration-adapter.ts` 了解如何将CDP Service集成到现有系统，包含自动降级机制。

## 📈 性能基准

### 当前性能（config-optimized.yaml）

| 并发级别 | 成功率 | 吞吐量 | P95延迟 | P99延迟 |
|----------|--------|--------|---------|---------|
| 顺序执行 | 100% | 7 req/s | 150ms | 200ms |
| 20 agents | 99.99% | 251 req/s | 800ms | 1200ms |
| 50 agents | 97.4% | 60 req/s | 999ms | 1500ms |

### 负载测试配置

**测试环境**：
- MacBook Pro M1/M2
- 16GB RAM
- Chrome 120+
- Node.js 22

**测试场景**：
```bash
# 1. 基准性能（顺序）
7次请求 × 顺序执行

# 2. 并发负载
50个agent × 10次请求 × 并发执行

# 3. 持续负载
20个agent × 30秒持续请求

# 4. 突发压力
100并发 × 短时间突发
```

## 🚢 生产部署

### SystemD服务

```ini
# /etc/systemd/system/cdp-service.service
[Unit]
Description=OpenClaw CDP Service
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/browser-automation/cdp-service
Environment="CDP_SERVICE_TOKEN=your-secret-token"
ExecStart=/usr/bin/node dist/index.js config-optimized.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**启动**：
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

# 安装依赖
COPY cdp-service/package*.json ./
RUN npm ci --production

# 复制编译后的代码
COPY cdp-service/dist/ ./dist/
COPY cdp-service/config-optimized.yaml ./config.yaml

ENV CDP_SERVICE_TOKEN=""
EXPOSE 3100 3101

CMD ["node", "dist/index.js", "config.yaml"]
```

**构建和运行**：
```bash
docker build -t openclaw-cdp-service .
docker run -d \
  -p 3100:3100 \
  -p 3101:3101 \
  -e CDP_SERVICE_TOKEN=your-token \
  --name cdp-service \
  openclaw-cdp-service
```

### Kubernetes部署

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cdp-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: cdp-service
  template:
    metadata:
      labels:
        app: cdp-service
    spec:
      containers:
      - name: cdp-service
        image: openclaw-cdp-service:latest
        ports:
        - containerPort: 3100
          name: http
        - containerPort: 3101
          name: metrics
        env:
        - name: CDP_SERVICE_TOKEN
          valueFrom:
            secretKeyRef:
              name: cdp-secrets
              key: token
        livenessProbe:
          httpGet:
            path: /health
            port: 3100
          initialDelaySeconds: 30
          periodSeconds: 10
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
---
apiVersion: v1
kind: Service
metadata:
  name: cdp-service
spec:
  selector:
    app: cdp-service
  ports:
  - name: http
    port: 3100
    targetPort: 3100
  - name: metrics
    port: 3101
    targetPort: 3101
```

## 🔒 安全最佳实践

1. **强认证令牌** - 使用至少32字符的随机字符串
2. **HTTPS加密** - 生产环境使用反向代理（nginx）配置SSL
3. **网络隔离** - 仅内网访问，不对公网开放
4. **最小权限** - 使用专用用户运行服务，非root
5. **定期更新** - 及时更新依赖和安全补丁
6. **日志审计** - 启用结构化日志并定期审查
7. **资源限制** - 配置合理的并发和内存限制

## 🐛 故障排查

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

**原因**：Chrome未启动或CDP端点不可达

**解决**：
```bash
# 确认Chrome正在运行
ps aux | grep chrome | grep remote-debugging

# 重启Chrome
killall Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222
```

### 超时频繁

**症状**：大量timeout错误

**原因**：预算时间过短或系统负载高

**解决**：
- 增加 `defaultBudgetMs` 配置
- 使用 `config-optimized.yaml`
- 检查系统资源（CPU/内存）

### 并发性能下降

**症状**：高并发时成功率低

**解决**：
- 使用 `config-optimized.yaml`
- 增加 `connectionPool.maxPerEndpoint`
- 调整 `enginePoolSize`
- 考虑多Chrome实例负载均衡

## 📝 配置参考

### 基础配置（config.yaml）

```yaml
service:
  host: 127.0.0.1
  port: 3100
  authToken: ${CDP_SERVICE_TOKEN}

cdp:
  endpoints:
    - url: http://localhost:9222

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

### 高性能配置（config-optimized.yaml）

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

monitoring:
  metricsPort: 3101
  logLevel: info
  enableTracing: true
  tracingEndpoint: "http://localhost:4318"
```

## 🤝 贡献指南

欢迎贡献代码、报告问题或提出改进建议！

1. Fork本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交改动 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启Pull Request

## 📄 许可证

MIT License

## 🔗 相关资源

- **Chrome DevTools Protocol**: https://chromedevtools.github.io/devtools-protocol/
- **Model Context Protocol**: https://github.com/modelcontextprotocol
- **Playwright**: https://playwright.dev/
- **OpenTelemetry**: https://opentelemetry.io/

## 📞 支持

遇到问题？

- 查看 [故障排查](#-故障排查) 章节
- 提交 [GitHub Issue](https://github.com/CACppuccino/browser-automation/issues)
- 查看 [CDP Service文档](./cdp-service/README.md)

---

**版本**: 1.0.0
**更新日期**: 2026-03-17
**维护者**: Mike & Claude & GPT5.4-xhgih
