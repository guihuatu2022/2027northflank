#!/bin/sh

# 1. 读取 Northflank 注入的环境变量，提供 fallback 默认值防止容器崩溃
LISTEN_PORT=${PORT:-8080}
# 注意：以下默认值仅为兜底，请务必在 Northflank 后台配置真实变量
CLIENT_UUID=${MY_UUID:-"a1b2c3d4-e5f6-7a8b-9c0d-123456789abc"}
XHTTP_PATH=${MY_PATH:-"/fallback-path-999"}

echo "Starting Sing-box on port: $LISTEN_PORT"

# 2. 批量执行替换操作
sed -e "s/PORT_PLACEHOLDER/${LISTEN_PORT}/g" \
    -e "s/UUID_PLACEHOLDER/${CLIENT_UUID}/g" \
    -e "s|PATH_PLACEHOLDER|${XHTTP_PATH}|g" \
    config.json.template > config.json

# 3. 启动 Sing-box
exec ./sing-box run -c config.json
