FROM alpine:latest

# 设置工作目录
WORKDIR /app

# 只需要安装时区数据即可，去掉了臃肿的 curl 和 tar
RUN apk add --no-cache tzdata

# 【核心修复与优化】直接从 GitHub 官方容器库提取最新版 sing-box 核心
# 这完美避开了版本号命名规则变化和 GitHub API 下载限速的问题
COPY --from=ghcr.io/sagernet/sing-box:latest /usr/local/bin/sing-box ./sing-box

# 【内存优化】针对 128MB 容器的 Go 运行时内存限制
ENV GOMEMLIMIT=100MiB
ENV GOGC=50

# 复制配置文件模板和启动脚本
COPY config.json.template .
COPY entrypoint.sh .

# 赋予执行权限
RUN chmod +x entrypoint.sh ./sing-box

# 声明默认端口 (运行时将被平台的 PORT 环境变量覆盖)
EXPOSE 8080

# 设置容器入口点
ENTRYPOINT ["./entrypoint.sh"]
