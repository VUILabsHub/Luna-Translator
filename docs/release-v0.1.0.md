# Luna Translator v0.1.0

首个可独立部署的 Web + Go 后端社区版本，Apache-2.0。

## 下载与运行

下载 `Luna-Translator-v0.1.0.zip` 或 `.tar.gz` 并解压。安装 Docker Engine/Desktop 和 Compose 后，在目录运行：

```sh
./start.sh
```

Windows PowerShell：`./start.ps1`。等待健康检查后打开 http://localhost:8088，使用脚本显示的部署密码登录。`SHA256SUMS.txt` 提供归档校验值。

默认明确标注的模拟模式，不需要 Key 或 GPU，不会识别或翻译实际语音。配置自己的 Luna / 百炼 API 后可进行真实同传；外部服务可能产生费用。配置方法见 README 与 docs/providers.md。

## 功能

- 单人同传、中英双向轮流发言、目标语言选择、原译文和译音。
- 麦克风或 PCM16 WAV 输入；完成时等待最后的 ASR、译音与归档。
- 单工作区密码登录、持久历史、原音与译音 WAV 回放/下载。
- 30 天分享快照、公开回放和撤销；删除历史会撤销对应分享并清理无其他引用的音频。
- Luna 公共 API、百炼实时 ASR、Embedding 向量评分适配；可通过应用接口扩展提供方。
- 两个容器、数据卷、健康检查、公开 CI、开发/部署/备份和贡献说明。

## 验证

80 项前端回归、生产构建、Go race、公开 Linux amd64 容器 CI、Apple Silicon 本地容器启动均通过。真实合成语音已验证中译英和英译中，浏览器验证了双向保存、四路音轨、历史、分享与撤销。npm / Go 当日依赖扫描无已知漏洞。详见 docs/validation.md。

## 范围与限制

模型权重、训练代码/数据和内部模型推理实现不分发。Android/iOS 源码与多人会议后续发布。字幕按整段或每轮发言展示，Embedding 不能代替已验证的逐句对齐模型。同部署密码共享工作区，不提供多租户隔离。

尚未完成真人麦克风、耳机/回声、Safari/Edge、Windows 实机与长会话负载验收；远程麦克风需要有效 HTTPS。浏览器真实模型验证使用合成 WAV，没有发送本机麦克风音频。

Welcome、线上 Web 与 iOS 官方下载入口见 README。官方产品与独立社区部署的账号、数据分开。
