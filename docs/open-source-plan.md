# Luna Translator 开源计划

更新：2026-10-30 · 首版 v0.1.0 · [社区仓库](https://github.com/VUILabsHub/Luna-Translator)

首版优先交付 Web 与对应 Go 后端，采用 Apache-2.0。社区开发者在安装 Docker / Compose 后，可下载源码并运行 `./start.sh`（Windows：`./start.ps1`）。无模型账号时使用明确标注的模拟模式；真实翻译需要部署者自行配置外部服务。

## 发布范围

| 首版提供 | 说明 |
|---|---|
| Web 单人同传 | 中/英输入、目标语言选择、字幕与译音，PCM16 WAV 或麦克风输入 |
| Web 双向对话 | 中英双方轮流发言；单部署共享工作区 |
| Go 产品后端 | 密码登录、一次性流会话凭据、音频转发、持久化和健康检查 |
| 历史、回放、分享 | 浏览、删除、归档 WAV、限时分享快照和撤销 |
| 模型适配器 | Luna 公共同传 API；百炼 ASR 和 Embedding |
| 独立部署与社区协作 | Compose、配置示例、许可、贡献/安全指南、公开 CI |

不发布 ASR、同传、Embedding 对齐等模型的权重、训练代码、训练数据或内部模型推理服务。公共 API 适配器仅负责应用调用。Android/iOS 源码、多人会议/RTC、评测标注、生产运维、计费与多租户账号体系不纳入首版。

## 推荐外部服务

- [Luna 同传 API](https://simultrans.lunalabs.cn/api-docs)：译文与译音，公开 Bearer WebSocket 协议；默认固定音色，不开启声音克隆。
- 百炼 `qwen3-asr-flash-realtime`：原文转写。
- 百炼 `text-embedding-v4`：整段原译文相似度；应用侧采用整段近似配对，不等同于内部逐句对齐模型。

服务权限、地域、额度与费用由部署者自己的账号承担。密钥仅配置在后端，不进入前端构建或公开 CI。详见 [服务配置](providers.md)。

## 已执行工作

- [x] 在独立仓库按允许清单整理 Web、必要共享代码与后端，不复制产品仓库的私有 Git 历史。
- [x] 完成 Apache-2.0、第三方许可及字体声明，移除生产配置、模型资产和用户数据。
- [x] 交付两个容器、同源 HTTP/WebSocket 代理、数据卷、自动生成工作区密码及启动脚本。
- [x] 提供单人/双向同传、历史、回放、限时分享与撤销接口。
- [x] 真实验证 Luna 中译英、英译中、百炼 ASR、Embedding，以及后端保存/分享/归档回放链路。
- [x] 通过 Web 构建、80 项前端回归、Go race、依赖漏洞和公开内容检查。
- [x] 提供公开 CI、架构、开发、配置、备份、升级与排障文档。

最终容器、浏览器、干净下载和远端发布证据以 [验收记录](validation.md) 为准。构建、合成语音测试和真人麦克风/设备验收分别记录。

## 后续路线

1. 完善真实麦克风与音频输出设备矩阵，持续验证 Chrome/Safari/Edge、回声与长会话。
2. 改进分段对齐、提供方扩展、无障碍和英文界面。
3. 按社区需求增加多人会议与可选 RTC；补充账号隔离、存储配额和运维能力。
4. 整理 Android/iOS 源码、独立构建与实机验收，单独发布移动端版本。

## 现有官方产品入口

| 入口 | 地址 |
|---|---|
| Welcome 产品介绍 | [了解 Luna 翻译](https://simultrans.lunalabs.cn/welcome/) |
| 线上 Web 体验 | [官方网页版](https://simultrans.lunalabs.cn/) |
| iOS 下载 | [App Store：Luna翻译](https://apps.apple.com/cn/app/id6806330215) |

官方产品与自行部署的社区工作区使用各自的账号、数据与服务配置。欢迎通过 [Issues](https://github.com/VUILabsHub/Luna-Translator/issues) 提出需求。
