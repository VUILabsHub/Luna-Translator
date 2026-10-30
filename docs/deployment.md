# 部署、备份与排障

## 本机

运行 `./start.sh` / `./start.ps1`，或 `docker compose up --build -d --wait`。默认 http://localhost:8088。修改 `.env` 后重跑启动命令。已有 `ADMIN_PASSWORD` 时使用该值；未设置时从 `/data/admin-password` 获取自动生成值。

可通过 `PORT`、`BIND_ADDRESS` 更换监听地址。首次构建需要公共 Docker Hub、npm 与 Go 模块网络。若网络需要代理，可给后端设置 `MODEL_HTTPS_PROXY` / `MODEL_HTTP_PROXY`；代理不是默认部署依赖。不要把代理凭据提交到仓库。

## 远程与 HTTPS

默认只绑定 127.0.0.1。远程访问应在同机反向代理之后运行，配置有效 HTTPS；浏览器麦克风只在安全上下文可用（localhost 例外）。代理须转发 WebSocket Upgrade，并保留浏览器 Host。应用不接受跨站 Origin 请求。

如需绑定外网地址，修改私有 `.env` 的 `BIND_ADDRESS`，结合防火墙、HTTPS 和访问控制。请勿把一个工作区当作相互隔离的多用户 SaaS；同一密码代表同一工作区。

## 数据与升级

```sh
docker compose ps
docker compose logs --tail=100 backend web
docker compose stop
```

停止应用后，可用 `docker compose run --rm --no-deps --entrypoint tar backend czf /data/backup.tar.gz -C /data state.json signing-key admin-password audio` 在数据卷内生成备份；如您使用 `ADMIN_PASSWORD` 且没有生成密码文件，去掉 `admin-password`。若暂无音频目录也应去掉 `audio`。请将备份拷贝至安全存储，并避免把备份提交到仓库。

升级：先停服备份，更新代码，重新运行 `./start.sh`。`docker compose down` 保留数据卷；**`docker compose down -v` 会删除工作区数据**，只在明确要清空该部署时执行。分享撤销和记录删除不能撤回访问者已经下载的内容。

## 常见问题

- 启动失败：查看 `docker compose logs`；端口冲突可改 `PORT`。模型缺失不会阻止模拟模式启动。
- 镜像/依赖下载超时：确认网络可访问公共服务，修复网络后重试；不需要访问公司的集群或镜像仓库。
- 真实模式无法开始：检查自己的 Key、地域和工作空间是否一致；确认模型服务已开通以及额度/并发限制。
- 没有原文：Luna 公共接口主要返回译文与语音，原文字幕需配置百炼 ASR。
- 浏览器无声：先点击页面操作以解锁播放，检查输出设备与音量；建议佩戴耳机避免外放回录。
- 分享失效：原记录被删除、链接过期或已撤销均会拒绝访问。
- WAV 输入：只支持无压缩 PCM16 WAV；文件最大 20 MiB，按实时速度发送。
