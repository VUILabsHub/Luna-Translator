# Luna Translator

A web-first real-time speech translation application, preparing for a community source release. The planned release includes the Web frontend, backend, and service adapters. AI models are accessed through external APIs and are not distributed with this project.

面向社区开发者的实时语音翻译项目，优先整理并开源 **Web 前端、后端及必要共享代码**，支持接入开发者自行配置的模型服务。

> 当前阶段：文档准备。本仓库先发布 README 与开源计划，应用源码、安装命令和可运行版本将在后续里程碑提供。

## 计划提供的能力

- 浏览器麦克风输入、实时原文与译文字幕。
- 翻译语音播放，以及相应的会话与音频处理。
- 服务端网关、模型服务适配和前后端通信协议。
- 可替换的服务配置，便于开发者接入自己的 ASR、同传和语义向量服务。
- 独立的本地开发流程、模拟服务与自动化检查。

以上为整理目标，具体首版能力以源码发布时的文档和验收记录为准。Android 与 iOS 安排在后续阶段。

## 开源范围

| 内容 | 计划 |
| --- | --- |
| Web 前端、后端、必要共享包 | 首版重点 |
| 模型接口、适配器和调用示例 | 随对应功能整理发布 |
| Android / iOS 客户端 | 后续里程碑 |
| ASR、同传、Embedding 对齐等模型 | 不包含模型权重、训练代码、训练数据或内部模型推理服务实现 |

## 外部模型服务

计划提供以下接入示例，服务地址、模型和长期凭据通过后端配置：

| 能力 | 推荐接入方向 | 参考 |
| --- | --- | --- |
| ASR 实时识别 | 阿里云百炼，例如 `qwen3-asr-flash-realtime` | [实时语音识别文档](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide) |
| Embedding 语义向量 | 阿里云百炼，例如 `text-embedding-v4` | [文本向量 API](https://docs.bailian.console.aliyun.com/en/model-studio/text-embedding-synchronous-api) |
| 同传 | Luna 同传服务 | [试用入口](https://simultrans.lunlabs.ai) |

接入示例与真实调用验证尚待完成。Luna 同传服务的具体 API、鉴权和试用条件将在核实后补充，不应将网站地址直接视为 API 地址。

Embedding 用于生成语义向量，对齐效果还取决于应用侧的文本分段与匹配策略。ASR、Embedding 与同传可以按需要组合；若同传服务已提供原文转写，可复用其结果。

模型服务可能需要单独开通，并受各服务的费用、配额和使用条款约束。

## 开源进度与参与

完整范围、实施阶段和发布验收条件见 [开源计划](docs/open-source-plan.md)。

现阶段欢迎通过 [Issues](https://github.com/VUILabsHub/Luna-Translator/issues) 提出使用场景、接口需求与文档建议。源码发布后将补充贡献指南与适合社区参与的任务。

## 许可证

项目许可证尚待确定，将在应用源码发布前补充 `LICENSE` 与必要的第三方声明。当前文档发布不表示模型或外部服务已获得开源授权。
