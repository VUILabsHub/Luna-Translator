# 模型服务与通信协议

本项目只公开应用及调用端。使用模型需要您自己的服务账号、API 权限及额度。

## Luna 公共 API

文档：https://simultrans.lunalabs.cn/api-docs

后端用 `Authorization: Bearer <your-key>` 连接 `LUNA_WS_URL`。服务端代码位于 `backend/providers/lunapublic/`，凭据不下发浏览器。

协议：发送 `action=start`，配置 `source_lang` / `target_lang`、`enable_tts=true`、`enable_vad=true`。默认固定音色为 `tts_backend=lunasi-tts-sc`、`voice_mode=preset`、`voice=avery`。收到 `started` 后实时发送 16 kHz 单声道 PCM16 二进制块；结束输入发送 `action=finish`，继续接收至 `completed`。

`translation` 是增量文本；`speech` / `speech_chunk` 的 JSON 描述紧随其后的 float32 二进制音频。适配器校验长度、采样率和非有限样本，转换为浏览器现有 PCM16 事件协议。`usage` 计量由模型服务处理；应用不承诺免费额度。

## 百炼

配置 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`DASHSCOPE_REGION`。原文识别通过 `qwen3-asr-flash-realtime`；可以使用 `DASHSCOPE_ASR_URL` 覆盖工作空间派生的 WebSocket 地址。Luna 原文与译文由两条独立模型链路生成，可能在措辞和时间边界上不完全一致。

向量评分使用 `text-embedding-v4` 的 OpenAI 兼容 `/embeddings` 接口，由 `DASHSCOPE_EMBEDDING_URL` 指定完整地址。请求包含本次原文与译文两段文本。当前应用只返回**整段近似配对与余弦相似度**；这不是逐句对齐准确率保证，也不包含内部 Embedding 对齐模型。

若需使用附带的百炼 LiveTranslate 适配器，可自行设置 `ENABLE_BAILIAN_TRANSLATE=true`；此替代翻译模型不作为首版默认链路，其真实权限与表现须自行验证。

## 浏览器到社区后端

1. `POST /api/community/login` 换取工作区 access token。
2. 带 Bearer 调用 `POST /api/consumer/ws/session`，指定 `provider`，获得 `sessionId` 与一次性 `ticket`。
3. 连接同源 `/ws/translate`，首个 JSON 为 `type=start`，包含上述票据、provider、sourceLanguage、targetLanguages。
4. 发送 16 kHz 单声道 PCM16 二进制。结束发送 `type=stop`，继续接收字幕、音频和 `state=finished`。

票据与 provider/sessionId 绑定，30 秒有效。输入语言为 zh/en；单次最多 3 个不重复目标语言；部署最多同时接收 4 条会话连接，每条最多 30 分钟，每方向音频内存上限 64 MiB。上游提供方的并发/额度可能更低。

模型未配置、鉴权失败、连接中断或超时时，应用返回错误；不会用模拟结果替代真实会话。`DEMO_MODE=true` 时只注册模拟服务，固定示例与提示音始终明确标注。
