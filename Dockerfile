FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache tzdata

# 直接从 Xray 官方镜像中提取编译好的二进制文件
COPY --from=teddysun/xray:latest /usr/bin/xray ./xray

COPY config.json.template .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh ./xray

EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
