# MCP Server安装和使用指南

## 什么是MCP？

MCP (Model Context Protocol) 是由Anthropic开发的标准化协议，用于AI模型与外部工具和数据源的交互。它为Claude等大型语言模型提供了访问浏览器自动化、文件系统、数据库等能力的标准接口。

## 安装MCP Server

### 前置要求

1. **CDP Service运行中**
   ```bash
   # 确保CDP Service已启动
   curl http://localhost:3100/health
   ```

2. **Node.js 22+**
   ```bash
   node --version  # 应显示 v22.x.x 或更高
   ```

### 安装步骤

```bash
# 1. 进入MCP server目录
cd browser-automation/mcp-server

# 2. 安装依赖
npm install

# 3. 设置环境变量
export CDP_SERVICE_URL="http://localhost:3100"
export CDP_SERVICE_TOKEN="your-secret-token"

# 4. 测试启动
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

**重要**：将 `/absolute/path/to/` 替换为实际的绝对路径。

### 验证配置

1. 重启Claude Desktop
2. 在Claude中输入："使用浏览器打开Google"
3. Claude应该能够看到并使用 `openclaw-browser` 工具

## MCP工具列表

配置成功后，Claude将获得以下浏览器自动化能力：

### 1. browser_evaluate
执行JavaScript代码并返回结果。

**示例对话**：
```
User: 请帮我打开Google并获取页面标题

Claude: 我来使用browser_evaluate工具获取页面标题
[调用 browser_evaluate]
expression: "document.title"

返回: "Google"
```

### 2. browser_navigate
导航到指定URL。

**示例对话**：
```
User: 打开GitHub网站

Claude: [调用 browser_navigate]
url: "https://github.com"
```

### 3. browser_click
点击页面元素。

**示例对话**：
```
User: 点击登录按钮

Claude: [调用 browser_click]
selector: "button.login-button"
```

### 4. browser_fill
填写表单字段。

**示例对话**：
```
User: 在搜索框输入"AI news"

Claude: [调用 browser_fill]
selector: "input[name='q']"
value: "AI news"
```

### 5. browser_snapshot
获取页面快照（HTML、cookies、URL）。

**示例对话**：
```
User: 获取当前页面的完整信息

Claude: [调用 browser_snapshot]
includeHtml: true
includeCookies: true
```

### 6. browser_extract
从页面提取结构化数据。

**示例对话**：
```
User: 提取页面中所有标题和链接

Claude: [调用 browser_extract]
selectors: {
  "mainTitle": "h1",
  "subtitle": "h2",
  "firstLink": "a"
}
```

### 7. browser_wait
等待元素出现或条件满足。

**示例对话**：
```
User: 等待加载动画消失

Claude: [调用 browser_wait]
condition: "!document.querySelector('.loading')"
timeoutMs: 10000
```

### 8. browser_health
检查CDP Service健康状态。

**示例对话**：
```
User: 检查浏览器服务状态

Claude: [调用 browser_health]
```

## 使用示例

### 示例1：搜索新闻

```
User: 帮我在Google搜索"OpenAI GPT-4 news"并告诉我前5个结果

Claude的操作流程：
1. [browser_navigate] url: "https://www.google.com"
2. [browser_fill] selector: "input[name='q']", value: "OpenAI GPT-4 news"
3. [browser_click] selector: "input[type='submit']"
4. [browser_wait] selector: "#search"
5. [browser_evaluate] expression: "Array.from(document.querySelectorAll('.g')).slice(0,5).map(el => ({title: el.querySelector('h3')?.textContent, link: el.querySelector('a')?.href}))"
```

### 示例2：登录网站

```
User: 帮我登录到example.com，用户名是test@example.com，密码是mypassword

Claude的操作流程：
1. [browser_navigate] url: "https://example.com/login"
2. [browser_fill] selector: "input[name='email']", value: "test@example.com"
3. [browser_fill] selector: "input[name='password']", value: "mypassword"
4. [browser_click] selector: "button[type='submit']"
5. [browser_wait] condition: "window.location.pathname === '/dashboard'"
```

### 示例3：数据收集

```
User: 访问news.ycombinator.com并收集今天的热门新闻标题

Claude的操作流程：
1. [browser_navigate] url: "https://news.ycombinator.com"
2. [browser_extract] selectors: {
     "titles": ".titleline > a",
     "points": ".score"
   }
```

## 故障排查

### MCP工具不可用

**问题**：Claude说"我没有浏览器工具可用"

**解决方案**：
1. 确认 `claude_desktop_config.json` 配置正确
2. 重启Claude Desktop
3. 检查MCP server日志：
   ```bash
   # 手动运行查看错误
   node /path/to/mcp-server/index.js
   ```

### CDP Service连接失败

**问题**：MCP工具报告"CDP Service error"

**解决方案**：
1. 确认CDP Service正在运行：
   ```bash
   curl http://localhost:3100/health
   ```
2. 检查认证令牌是否正确
3. 查看CDP Service日志

### 权限错误

**问题**：MCP server启动失败，提示权限错误

**解决方案**：
```bash
# 确保脚本有执行权限
chmod +x /path/to/mcp-server/index.js

# 确保Node.js可执行
which node
```

## 高级配置

### 自定义超时

修改 `mcp-server/index.js` 中的默认超时：

```javascript
const cdpClient = new CdpServiceClient({
  serviceUrl: process.env.CDP_SERVICE_URL || 'http://localhost:3100',
  authToken: process.env.CDP_SERVICE_TOKEN,
  defaultTimeout: 60000  // 增加到60秒
});
```

### 添加自定义工具

在 `index.js` 中添加新工具：

```javascript
const TOOLS = [
  // ... 现有工具
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean" },
        agentId: { type: "string" }
      }
    }
  }
];

// 在CallToolRequestSchema处理器中添加实现
case "browser_screenshot":
  // 实现截图逻辑
  break;
```

### 多CDP Service实例

如果有多个CDP Service实例，可以配置负载均衡：

```javascript
const CDP_SERVICES = [
  'http://localhost:3100',
  'http://localhost:3101',
  'http://localhost:3102'
];

let currentIndex = 0;
function getNextCdpService() {
  const url = CDP_SERVICES[currentIndex];
  currentIndex = (currentIndex + 1) % CDP_SERVICES.length;
  return url;
}
```

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

## 参考资源

- [MCP官方文档](https://modelcontextprotocol.io/)
- [Claude Desktop配置指南](https://docs.anthropic.com/claude/docs/claude-desktop)
- [CDP Service API文档](../cdp-service/README.md)
