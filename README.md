# OpenClaw WeChat Windows Channel

Windows版本的微信插件，通过chatlog Webhook接收消息，通过剪贴板发送。

## 功能特性

- ✅ 通过chatlog Webhook接收完整消息（支持长文本、图片、文件）
- ✅ 通过剪贴板自动发送消息（Ctrl+V + Enter）
- ✅ 支持图文混发
- ✅ 消息去重
- ✅ 多账号支持（配置文件）
- ✅ 消息类型识别（文本、图片、语音、视频、文件）

## 安装

### 1. 安装chatlog（必需）

chatlog是微信消息抓取工具，用于提供Webhook接口。

**Windows用户配置指南**：

1. **获取微信密钥**：
   ```bash
   # 在Windows微信中运行
   wx_key.exe
   ```

2. **配置chatlog**：
   修改 `config.json`：
   ```json
   {
     "enable": true,
     "webhookUrl": "http://localhost:18789/api/webhook",
     "databaseKey": "你的数据库密钥",
     "imageKey": "你的图片密钥",
     "enabledSenders": ["*"]
   }
   ```

3. **启动chatlog**：
   ```bash
   chatlog.exe
   ```

### 2. 安装OpenClaw插件

```bash
openclaw plugins install C:\Users\Noel\Desktop\openclaw-wechat-plugin-windows
```

### 3. 配置OpenClaw

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "name": "微信",
      "allowedSenders": ["*"]
    }
  }
}
```

### 4. 重启gateway

```bash
openclaw gateway restart
```

## 配置说明

### channels.wechat 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 是否启用微信通道 |
| `name` | string | "WeChat" | 通道名称 |
| `allowedSenders` | string[] | [] | 白名单（留空则允许所有人） |

## 消息格式

### 接收消息格式

chatlog通过Webhook推送消息，格式如下：

```json
{
  "messages": [
    {
      "seq": 12345,
      "isSelf": false,
      "type": 1,
      "sender": "用户昵称",
      "senderName": "用户昵称",
      "content": "消息内容",
      "talker": "聊天对象ID"
    }
  ]
}
```

**消息类型**：
- `1` - 文本消息
- `3` - 图片消息
- `34` - 语音消息
- `43` - 视频消息
- `49` - 文件/链接

### 发送消息格式

使用 `MEDIA:/path/to/file` 标记发送本地文件：

```
这是图片 MEDIA:/Users/xxx/image.png 后面还有文字
```

## 限制

- ⚠️ **需要chatlog** - 插件依赖chatlog提供Webhook接口
- ⚠️ **需要微信登录** - 微信需要保持登录状态
- ⚠️ **Windows only** - 仅支持Windows系统
- ⚠️ **剪贴板发送** - 通过剪贴板模拟粘贴，可能受其他程序干扰

## 常见问题

### Q: 发送消息后微信没有反应？

A: 检查：
1. 微信是否启动
2. 剪贴板是否正常工作
3. 查看gateway日志

### Q: 消息接收失败？

A: 检查：
1. chatlog是否正常运行
2. Webhook URL是否正确
3. 微信密钥是否配置正确

### Q: 中文乱码？

A: 确保chatlog使用UTF-8编码：
```json
{
  "webhookUrl": "http://localhost:18789/api/webhook",
  "encoding": "utf8"
}
```

## 项目结构

```
openclaw-wechat-plugin-windows/
├── index.ts              # 主插件代码
├── openclaw.plugin.json  # 插件配置
├── README.md             # 说明文档
└── package.json          # 依赖配置
```

## 许可证

MIT
