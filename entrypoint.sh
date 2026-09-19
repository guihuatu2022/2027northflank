#!/bin/sh
LISTEN_PORT=${PORT:-8080}
CLIENT_UUID=${MY_UUID:-"a1b2c3d4-e5f6-7a8b-9c0d-123456789abc"}
XHTTP_PATH=${MY_PATH:-"/fallback-path-999"}

echo "Starting Xray-core on port: $LISTEN_PORT"

sed -e "s/\"PORT_PLACEHOLDER\"/${LISTEN_PORT}/g" \
    -e "s/UUID_PLACEHOLDER/${CLIENT_UUID}/g" \
    -e "s|PATH_PLACEHOLDER|${XHTTP_PATH}|g" \
    config.json.template > config.json

# Xray 的启动命令
exec ./xray -config config.json
