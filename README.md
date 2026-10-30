# Luna Translator

可独立部署的实时语音翻译 Web 应用。首版提供 **Web 前端、Go 后端、单人/双向同传、历史、音频回放与可撤销分享**，采用 [Apache-2.0](LICENSE)。[English](README.en.md)

模型通过外部 API 调用，仓库不包含 ASR、同传、Embedding 模型的权重、训练代码、训练数据或模型推理服务。Android、iOS 与多人会议安排在后续版本。

## 下载与一键启动

前提：已安装 [Docker Engine/Desktop 和 Compose](https://docs.docker.com/compose/install/)，可访问公开镜像及 npm/Go 依赖源。无需 GPU、Node、Go、短信平台或外部数据库。

下载本仓库的 ZIP 并解压，或 `git clone https://github.com/VUILabsHub/Luna-Translator.git`。进入目录后执行：

```sh
./start.sh
```

Windows PowerShell：

```powershell
./start.ps1
```

脚本构建并启动两个容器，等待健康检查，并显示本部署自动生成的工作区密码。打开 **http://localhost:8088** 登录。也可使用原生命令：

```sh
docker compose up --build -d --wait
docker compose exec backend cat /data/admin-password
```

默认是**明确标注的模拟体验**：不需要模型密钥，显示固定示例字幕与提示音，不能识别或翻译您的真实语音。配置真实服务后才可进行实际同传。首次下载会构建镜像，需要网络；这里的一键启动不包含云模型账号申请。

这是一个**单工作区部署**：持有同一个部署密码的使用者共享历史和模型额度。不同用户应使用独立部署。默认仅绑定本机 `127.0.0.1`；远程部署见 [部署指南](docs/deployment.md)。

## 接入真实同传

复制 `.env.example` 为 `.env`，填写自己开通的服务配置：

```dotenv
DEMO_MODE=false
LUNA_API_KEY=your-own-api-key
LUNA_WS_URL=wss://simultrans.lunalabs.cn/v1/realtime/translate
DASHSCOPE_API_KEY=your-own-model-studio-key
DASHSCOPE_WORKSPACE_ID=your-workspace-id
DASHSCOPE_REGION=cn-beijing
DASHSCOPE_EMBEDDING_URL=https://your-workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings
```

然后再次执行 `./start.sh`。密钥只进入后端运行环境，不进入 Web 构建。**不要将自己的 `.env` 提交或发送到公开 Issue。**

- Luna：实时译文与合成语音；[API 文档](https://simultrans.lunalabs.cn/api-docs)。固定音色使用公开 API 的 `lunasi-tts-sc` / `avery`，默认不开启声音克隆。
- 百炼 ASR：`qwen3-asr-flash-realtime`，为 Luna 链路补充原文字幕；[官方指南](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)。未配置 ASR 时，Luna 译文和语音仍可用，原文字幕不可用，页面会提示。
- 百炼 Embedding：`text-embedding-v4`，对整段原文/译文进行向量相似度评分；[官方 API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)。这不是原内部对齐模型的复制品，不提供已验证的逐句精确对齐；未配置时使用明确标记的整段近似配对。

输入支持中文/英语，Luna 输出语种按其公开 API 配置；单次最多选 3 种目标语言，每个目标语言单独建立上游调用，会分别占用额度。服务的权限、价格、地域与并发限制由各提供方决定。详见 [模型配置与协议](docs/providers.md)。

## 验证与使用

- 麦克风：选择语言 → 开始同传 → 授权音频 → 查看原文/译文及语音 → 停止。
- 可复现文件输入：选择无压缩 PCM16 WAV → 开始同传。文件按实时速度发送，使用与麦克风相同的后端协议，不读取麦克风。
- 双向同传：切换「对话」，中英双方轮流说话；首版不包含多人会议/RTC。
- 历史：停止后保存至本部署数据卷；可回放归档 WAV、浏览和删除记录。
- 分享：生成限时快照链接；持有链接的人可读取快照及其音频；可撤销，删除原记录也会撤销其分享并清理无其他引用的音频。

[验收记录](docs/validation.md)分别列出构建、离线测试、真实云服务、容器和浏览器结果。[开源计划](docs/open-source-plan.md)记录剩余里程碑。

## 开发与贡献

```sh
npm ci
npm run build --workspace web
go -C backend test -race ./...
```

开发运行需要 Node.js 22.12+、Go 1.26.10+；Docker 部署不需要本机安装这些工具。前端调试执行 `npm run dev --workspace web`，后端通过 `DATA_DIR`、`ADMIN_PASSWORD` 和模型环境变量配置后执行 `go -C backend run .`。

更多说明：[架构与数据](docs/architecture.md)、[备份/升级/排障](docs/deployment.md)、[贡献指南](CONTRIBUTING.md)、[第三方许可](THIRD_PARTY_NOTICES.md)。

## 现有官方产品入口

| 入口 | 地址 |
|---|---|
| Welcome 产品介绍 | [了解 Luna 翻译](https://simultrans.lunalabs.cn/welcome/) |
| 线上 Web 体验 | [打开官方网页版](https://simultrans.lunalabs.cn/) |
| iOS 下载 | [App Store：Luna翻译](https://apps.apple.com/cn/app/id6806330215) |

以上官方产品与自行部署的社区工作区使用各自的账号和数据。移动端已有下载入口，移动端源码后续整理。
