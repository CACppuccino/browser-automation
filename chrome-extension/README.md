# Chrome Extension（可选组件）

目前CDP Service通过Chrome的Remote Debugging Protocol直接控制浏览器，**不需要**安装Chrome扩展即可使用全部功能。

## 扩展的用途

Chrome扩展可以提供以下增强功能（未来实现）：

1. **可视化调试面板** - 在浏览器中查看CDP命令执行状态
2. **请求拦截** - 拦截和修改网络请求
3. **自定义注入脚本** - 在页面加载前注入JavaScript
4. **增强的Cookie管理** - 跨域Cookie操作
5. **页面录制回放** - 录制用户操作并回放

## 当前状态

Chrome扩展功能处于规划阶段。CDP Service已经通过CDP协议提供了完整的浏览器控制能力，包括：

- ✅ JavaScript执行
- ✅ DOM操作
- ✅ 页面导航
- ✅ Cookie管理
- ✅ 网络监控
- ✅ 截图和PDF生成

如果需要扩展功能，请提交Issue或Pull Request。

## 开发Chrome扩展（如果需要）

### Manifest V3模板

```json
{
  "manifest_version": 3,
  "name": "OpenClaw Browser Automation Helper",
  "version": "1.0.0",
  "description": "Enhanced browser automation capabilities for OpenClaw",
  "permissions": [
    "debugger",
    "storage",
    "tabs",
    "webRequest"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "devtools_page": "devtools.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  }
}
```

### 安装开发版扩展

1. 打开Chrome: `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `chrome-extension/` 文件夹

## 未来功能规划

- [ ] DevTools面板集成
- [ ] 网络请求拦截和修改
- [ ] 自定义脚本注入
- [ ] 操作录制和回放
- [ ] 可视化的CDP命令监控
