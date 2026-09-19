FROM alpine:latest

# 设置工作目录
WORKDIR /app

# 安装基础依赖 (curl 下载, tar 解压)
RUN apk add --no-cache curl tar tzdata

# 下载最新版 Sing-box (64位 Linux)
RUN curl -L -o sing-box.tar.gz https://github.com/SagerNet/sing-box/releases/latest/download/sing-box-linux-amd64.tar.gz && \
    tar -xzf sing-box.tar.gz && \
    mv sing-box-*/sing-box . && \
    rm -rf sing-box-* sing-box.tar.gz && \
    chmod +x sing-box

# 复制配置文件模板和启动脚本
COPY config.json.template .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# 声明默认端口
EXPOSE 8080

# 设置容器入口点
ENTRYPOINT ["./entrypoint.sh"]
