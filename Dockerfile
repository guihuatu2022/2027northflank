FROM alpine:latest

WORKDIR /app

RUN apk add --no-cache curl tar tzdata

RUN curl -L -o sing-box.tar.gz https://github.com/SagerNet/sing-box/releases/latest/download/sing-box-linux-amd64.tar.gz && \
    tar -xzf sing-box.tar.gz && \
    mv sing-box-*/sing-box . && \
    rm -rf sing-box-* sing-box.tar.gz && \
    chmod +x sing-box

# 【核心优化】针对 128MB 容器的 Go 运行时内存限制
# GOMEMLIMIT: 设置软内存上限为 100MB，防止突发流量撑爆 128MB 容器
# GOGC: 调低 GC 阈值（默认100，改为50），让内存回收更积极
ENV GOMEMLIMIT=100MiB
ENV GOGC=50

COPY config.json.template .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
