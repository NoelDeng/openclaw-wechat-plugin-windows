import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { exec as execCallback, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenClawPluginApi,
  PluginRuntime,
  ClawdbotConfig,
  RuntimeEnv,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  emptyPluginConfigSchema,
  createReplyPrefixContext,
  createTypingCallbacks,
} from "openclaw/plugin-sdk";

const exec = promisify(execCallback);

// 带 UTF-8 环境变量的 exec，解决中文乱码问题
async function execWithUtf8(command: string): Promise<{ stdout: string; stderr: string }> {
  return exec(command, {
    env: {
      ...process.env,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
}

// ============================================================
// Runtime 管理
// ============================================================

let runtime: PluginRuntime | null = null;
let pluginApi: OpenClawPluginApi | null = null;

// 消息去重：存储已处理的消息 key（发送者 + 内容前20字符）
const processedMessages = new Set<string>();
const MAX_PROCESSED_MESSAGES = 1000;

// 生成消息去重 key
function getMessageKey(sender: string, content: string): string {
  const contentPrefix = content.slice(0, 20);
  return `${sender}:::${contentPrefix}`;
}

function isMessageProcessed(sender: string, content: string): boolean {
  const key = getMessageKey(sender, content);
  return processedMessages.has(key);
}

function markMessageProcessed(sender: string, content: string): void {
  const key = getMessageKey(sender, content);
  
  // 清理旧记录，避免内存无限增长
  if (processedMessages.size >= MAX_PROCESSED_MESSAGES) {
    const toDelete = Array.from(processedMessages).slice(0, 200);
    toDelete.forEach((k) => processedMessages.delete(k));
  }
  
  processedMessages.add(key);
}

// ============================================================
// 微信消息发送 (Peekaboo + 剪贴板)
// ============================================================

// 清理 Markdown 格式（微信不支持 Markdown 显示）
function stripMarkdown(text: string): string {
  let result = text;
  
  // 移除代码块（保留内容）
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "$1");
  
  // 移除行内代码（保留内容）
  result = result.replace(/`([^`]+)`/g, "$1");
  
  // 移除粗体 **text** 或 __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  
  // 移除斜体 *text* 或 _text_（注意不要误伤正常下划线）
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  
  // 移除链接 [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  
  // 移除标题 # ## ### 等
  result = result.replace(/^#{1,6}\s+/gm, "");
  
  // 移除引用 > 
  result = result.replace(/^>\s?/gm, "");
  
  // 移除水平线
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");
  
  return result.trim();
}

// 激活微信窗口
async function activateWeChat(): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  
  log(`[wechat-win] Activating WeChat...`);
  await execWithUtf8(`start "" "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe"`);

  // 等待微信启动
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

// 粘贴文字到剪贴板并发送
async function sendTextToWeChat(text: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const cleanText = stripMarkdown(text);

  log(`[wechat-win] Sending text (${cleanText.length} chars)...`);

  // 复制到剪贴板
  const escapedText = cleanText.replace(/"/g, '\\"');
  await execWithUtf8(`echo "${escapedText}" | clip`);

  // 等待剪贴板就绪
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 激活微信
  await activateWeChat();

  // Ctrl+V 粘贴
  await execWithUtf8(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^{v}')"`);
  
  // 等待粘贴完成
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Enter 发送
  await execWithUtf8(`powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('^{enter}')"`);

  // 等待发送完成
  await new Promise((resolve) => setTimeout(resolve, 500));

  log(`[wechat-win] Text sent successfully`);
}

// 发送媒体文件到微信
async function sendMediaToWeChat(filePath: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  log(`[wechat-win] Sending media: ${filePath}`);

  // 复制文件到剪贴板
  const escapedPath = filePath.replace(/\\/g, "\\\\");
  await execWithUtf8(`powershell -Command "Set-Clipboard -Path '${escapedPath}'"`);

  // 等待剪贴板就绪
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 激活微信
  await activateWeChat();

  // Ctrl+V 粘贴
  await execWithUtf8(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^{v}')"`);
  
  // 等待粘贴完成
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Enter 发送
  await execWithUtf8(`powershell -Command "[System.Windows.Forms.SendKeys]::SendWait('^{enter}')"`);

  // 等待发送完成
  await new Promise((resolve) => setTimeout(resolve, 500));

  log(`[wechat-win] Media sent successfully`);
}

// ============================================================
// Reply Dispatcher
// ============================================================

type CreateWechatReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtimeEnv: RuntimeEnv;
  chatId: string;
};

function createWechatReplyDispatcher(params: CreateWechatReplyDispatcherParams) {
  const core = getWechatRuntime();
  const { cfg, agentId, runtimeEnv, chatId } = params;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      runtimeEnv.log?.(`wechat: typing started`);
    },
    stop: async () => {
      runtimeEnv.log?.(`wechat: typing stopped`);
    },
    onStartError: () => {},
    onStopError: () => {},
  });

  let deliverCalled = false;
  let deliverBuffer = "";

  // 将 buffer 内容解析并发送
  async function flushDeliverBuffer(extraMediaPaths?: string[]): Promise<void> {
    const text = deliverBuffer;
    deliverBuffer = "";

    const hasText = !!text.trim();
    const hasMedia = extraMediaPaths && extraMediaPaths.length > 0;

    if (!hasText && !hasMedia) return;

    deliverCalled = true;

    // 从文本中解析 parts（文字 + 自动检测路径）
    const parts: MessagePart[] = hasText ? parseMessageWithMedia(text) : [];

    // 追加框架传入的媒体文件
    if (hasMedia) {
      for (const mediaPath of extraMediaPaths) {
        parts.push({ type: "media", path: mediaPath });
      }
    }

    runtimeEnv.log?.(`wechat deliver flush: ${parts.length} parts (text=${hasText}, extraMedia=${extraMediaPaths?.length ?? 0})`);

    // 发送文字部分
    if (parts.some(p => p.type === "text")) {
      const textParts = parts.filter(p => p.type === "text").map(p => p.content);
      await sendTextToWeChat(textParts.join(""));
    }

    // 发送媒体部分
    for (const part of parts.filter(p => p.type === "media")) {
      await sendMediaToWeChat(part.path);
    }

    runtimeEnv.log?.(`wechat deliver flush: complete`);
  }

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        runtimeEnv.log?.(`wechat deliver called: text=${payload.text?.slice(0, 100)}`);

        // 提取框架传入的媒体路径
        const payloadAny = payload as any;
        const mediaPaths: string[] = [];
        if (Array.isArray(payloadAny.mediaUrls) && payloadAny.mediaUrls.length > 0) {
          for (const u of payloadAny.mediaUrls) {
            if (typeof u === "string" && u.trim()) mediaPaths.push(u.trim());
          }
        } else if (typeof payloadAny.mediaUrl === "string" && payloadAny.mediaUrl.trim()) {
          mediaPaths.push(payloadAny.mediaUrl.trim());
        }

        if (mediaPaths.length > 0) {
          runtimeEnv.log?.(`wechat deliver: found ${mediaPaths.length} media from payload`);
        }

        const incoming = payload.text ?? "";
        if (!incoming.trim() && !deliverBuffer && mediaPaths.length === 0) {
          runtimeEnv.log?.(`wechat deliver: empty text and no media, skipping`);
          return;
        }

        // 纯媒体 payload（无文字）→ 立即发送
        if (!incoming.trim() && !deliverBuffer && mediaPaths.length > 0) {
          await flushDeliverBuffer(mediaPaths);
          return;
        }

        deliverBuffer += incoming;

        // 有媒体附件时立即 flush
        if (mediaPaths.length > 0) {
          await flushDeliverBuffer(mediaPaths);
          return;
        }

        // buffer 完整，flush
        await flushDeliverBuffer();
      },
      onError: (err, info) => {
        runtimeEnv.error?.(`wechat ${info.kind} reply failed: ${String(err)}`);
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        // 流结束时，强制 flush 剩余 buffer
        if (deliverBuffer.trim()) {
          runtimeEnv.log?.(`wechat onIdle: flushing remaining buffer (${deliverBuffer.length} chars)`);

          const parts = parseMessageWithMedia(deliverBuffer);
          if (parts.some(p => p.type === "text")) {
            const textParts = parts.filter(p => p.type === "text").map(p => p.content);
            await sendTextToWeChat(textParts.join(""));
          }
          for (const part of parts.filter(p => p.type === "media")) {
            await sendMediaToWeChat(part.path);
          }
        }
        typingCallbacks.onIdle?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
    wasDelivered: () => deliverCalled,
  };
}

// ============================================================
// 消息处理
// ============================================================

type WechatMessageContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  chatType: "direct" | "group";
  content: string;
};

async function handleWechatMessage(params: {
  cfg: ClawdbotConfig;
  ctx: WechatMessageContext;
  runtimeEnv: RuntimeEnv;
}): Promise<void> {
  const { cfg, ctx, runtimeEnv } = params;
  const log = runtimeEnv.log ?? console.log;
  const error = runtimeEnv.error ?? console.error;

  log(`wechat: received message from ${ctx.senderName} in ${ctx.chatId}`);

  try {
    const core = getWechatRuntime();

    const wechatFrom = `wechat:${ctx.senderId}`;
    const wechatTo = `wechat:${ctx.chatId}`;

    // 解析路由
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      peer: {
        kind: ctx.chatType === "group" ? "group" : "dm",
        id: ctx.chatId,
      },
    });

    // 生成独立的 sessionKey
    const sessionKey = `wechat:${ctx.chatType === "group" ? "group" : "dm"}:${ctx.chatId}`;

    // 直接使用纯消息内容
    const body = ctx.content;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: wechatFrom,
      To: wechatTo,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: ctx.chatType,
      SenderName: ctx.senderName,
      SenderId: ctx.senderId,
      Provider: "wechat" as const,
      Surface: "wechat" as const,
      MessageSid: ctx.messageId,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "wechat" as const,
      OriginatingTo: wechatTo,
    });

    const { dispatcher, replyOptions, markDispatchIdle, wasDelivered } = createWechatReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtimeEnv,
      chatId: ctx.chatId,
    });

    log(`wechat: dispatching to agent (session=${sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    log(`wechat: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final}, delivered=${wasDelivered()})`);

    // 只有当 deliver 从未被调用时才发送 ⏹️
    if (!queuedFinal && counts.final === 0 && !wasDelivered()) {
      log(`wechat: no replies sent, sending stop notification`);
      await sendTextToWeChat("⏹️");
    }
  } catch (err) {
    error(`wechat: failed to dispatch message: ${String(err)}`);
  }
}

// ============================================================
// Webhook Handler
// ============================================================

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleWechatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ClawdbotConfig,
  runtimeEnv: RuntimeEnv
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/webhook") return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const webhookData = body.value as any;
  const messages = Array.isArray(webhookData?.messages) ? webhookData.messages : [];

  if (messages.length === 0) {
    res.statusCode = 200;
    res.end("ok");
    return true;
  }

  const log = runtimeEnv.log ?? console.log;

  log(`[wechat-webhook] Received ${messages.length} messages`);

  // 立即返回 200，异步处理消息
  res.statusCode = 200;
  res.end("ok");

  const coreRuntime = getWechatRuntime();

  // 处理每条消息
  for (const msg of messages) {
    log(`[wechat-webhook] Message: seq=${msg.seq}, isSelf=${msg.isSelf}, sender=${msg.sender}, content=${String(msg.content).substring(0, 30)}...`);
    
    // 跳过自己发送的消息
    if (msg.isSelf === true) {
      log(`[wechat-webhook] Skipping self message`);
      continue;
    }

    // 处理消息类型
    const messageType = msg.type;
    let content = msg.content;

    switch (messageType) {
      case 1:
        // 纯文本，保持原样
        break;
      case 3:
        content = `[图片] ${content}`;
        break;
      case 34:
        content = `[语音] ${content}`;
        break;
      case 43:
        content = `[视频] ${content}`;
        break;
      case 49:
        content = `[文件/链接] ${content}`;
        break;
      default:
        content = `[消息类型:${messageType}] ${content}`;
        break;
    }

    const senderName = msg.senderName || msg.sender || "微信用户";

    // 发件人白名单过滤
    const allowedSenders = (cfg as any)?.channels?.wechat?.allowedSenders as string[] | undefined;
    if (allowedSenders && allowedSenders.length > 0) {
      if (!allowedSenders.includes(senderName)) {
        log(`[wechat-webhook] Ignored message from unlisted sender: ${senderName}`);
        continue;
      }
    }

    // 去重检查
    if (isMessageProcessed(senderName, content)) {
      log(`[wechat-webhook] Message already processed, skipping: ${senderName}`);
      continue;
    }

    const senderId = msg.sender || msg.talker || "unknown";
    const chatId = msg.talker || msg.sender || "unknown";
    const messageId = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    log(`[wechat-webhook] Processing message from ${senderName}: ${content.substring(0, 50)}...`);

    const ctx: WechatMessageContext = {
      chatId,
      messageId,
      senderId,
      senderName,
      chatType: msg.isChatRoom ? "group" : "direct",
      content,
    };

    // 调用内部消息处理
    handleWechatMessage({ cfg, ctx, runtimeEnv }).catch((err) => {
      runtimeEnv.error?.(`[wechat-webhook] Failed to handle message: ${err}`);
    });
  }

  return true;
}

// ============================================================
// Channel Plugin 定义
// ============================================================

type WechatChannelConfig = {
  enabled?: boolean;
  name?: string;
  allowedSenders?: string[];
};

function getWechatConfig(cfg: any): WechatChannelConfig {
  return (cfg?.channels?.wechat as WechatChannelConfig) ?? {};
}

function resolveWechatAccount(cfg: any): {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
} {
  const wechatCfg = getWechatConfig(cfg);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wechatCfg.name ?? "WeChat",
    enabled: wechatCfg.enabled ?? true,
    configured: true, // 微信通过 Webhook 自动化，不需要额外配置
  };
}

const wechatPlugin = {
  id: "wechat",
  meta: {
    id: "wechat",
    label: "WeChat",
    selectionLabel: "WeChat (Windows + Chatlog)",
    blurb: "Windows微信插件，通过chatlog Webhook接收消息，剪贴板发送",
    aliases: ["wechat", "weixin"],
    order: 80,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },
  reload: { configPrefixes: ["channels.wechat"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: any) => resolveWechatAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "stream",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text }: { cfg: any; to: string; text: string }) => {
      pluginApi?.logger?.info(`[wechat-outbound] sendText called! to=${to}`);
      await sendTextToWeChat(text);
      return {
        channel: "wechat",
        ok: true,
        messageId: `wechat-${Date.now()}`,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }: { cfg: any; to: string; text?: string; mediaUrl?: string }) => {
      pluginApi?.logger?.info(`[wechat-outbound] sendMedia called! to=${to}, mediaUrl=${mediaUrl}`);
      
      // 如果有文字，先发送文字
      if (text?.trim()) {
        await sendTextToWeChat(text);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      
      // 发送媒体文件
      if (mediaUrl) {
        let filePath = mediaUrl;
        if (filePath.startsWith("file://")) {
          filePath = filePath.replace("file://", "");
        }
        if (filePath.startsWith("~")) {
          filePath = filePath.replace("~", process.env.USERPROFILE || "C:\\Users\\" + process.env.USERNAME);
        }
        
        await sendMediaToWeChat(filePath);
      }
      
      return {
        channel: "wechat",
        ok: true,
        messageId: `wechat-${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (gatewayCtx: any) => {
      gatewayCtx.log?.info?.(`wechat: starting provider`);
      gatewayCtx.setStatus({ accountId: gatewayCtx.accountId, port: null });

      const log = gatewayCtx.log?.info?.bind(gatewayCtx.log) ?? console.log;
      const error = gatewayCtx.log?.error?.bind(gatewayCtx.log) ?? console.error;
      const cfg = gatewayCtx.cfg;

      // 构建 runtimeEnv
      const runtimeEnv: RuntimeEnv = {
        log,
        error,
      };

      // 返回一个永不 resolve 的 Promise 保持运行
      return new Promise<void>((resolve) => {
        gatewayCtx.abortSignal?.addEventListener("abort", () => {
          gatewayCtx.log?.info?.(`wechat: provider stopped`);
          resolve();
        });
      });
    },
  },
};

// ============================================================
// 插件注册
// ============================================================

const plugin = {
  id: "wechat",
  name: "WeChat Windows Channel",
  description: "Receives WeChat messages via Chatlog Webhook on Windows, sends via clipboard.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    pluginApi = api;

    setWechatRuntime(api.runtime);

    api.logger.info(`[wechat-win] Plugin registering...`);

    // 注册 channel
    api.registerChannel({ plugin: wechatPlugin as any });

    // 注册 HTTP handler
    api.registerHttpHandler(async function wechatWebhookHandler(
      req: IncomingMessage,
      res: ServerResponse
    ): Promise<boolean> {
      return await handleWechatWebhookRequest(
        req,
        res,
        api.config as ClawdbotConfig,
        api.runtime as unknown as RuntimeEnv
      );
    });

    api.logger.info("WeChat Windows channel plugin activated. Listening for webhooks on /api/webhook");
  },
};

export default plugin;
