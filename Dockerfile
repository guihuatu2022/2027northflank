FROM alpine:latest

# 设置工作目录
WORKDIR /app

# 安装基础依赖 (curl 用于下载, unzip 用于解压)
RUN apk add --no-cache curl unzip tzdata

# 下载最新版 Xray-core (64位 Linux)
RUN curl -L -o xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip && \
    unzip xray.zip xray && \
    rm xray.zip && \
    chmod +x xray

# 复制配置文件模板和启动脚本
COPY config.json.template .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# 声明默认端口 (Northflank 会动态覆盖)
EXPOSE 8080

# 设置容器入口点
ENTRYPOINT ["./entrypoint.sh"]
