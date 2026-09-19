# =============================================================================
#  Dockerfile - VLESS + XHTTP origin for Northflank
#
#  Files required in the repository root, side by side with this Dockerfile:
#      Dockerfile
#      entrypoint.sh          <- must be here, or the build fails at step 3
#      .github/workflows/build.yml
#
#  This image runs ONLY vless + xhttp over plain HTTP. It deliberately does NOT
#  do TLS: TLS is terminated by the Northflank edge in front of the container,
#  and by Cloudflare in front of Northflank. Keeping TLS out of the container is
#  what keeps its memory footprint small.
#
#  Every tunable is an environment variable - see .env.example
# =============================================================================

FROM alpine:3.21

# Pinned Xray-core release. Bump via the XRAY_VERSION build arg / workflow env.
ARG XRAY_VERSION=v26.3.27
# Filled in automatically by docker buildx for multi-arch builds (amd64/arm64).
ARG TARGETARCH

RUN set -eux; \
    apk add --no-cache ca-certificates tzdata; \
    case "${TARGETARCH}" in \
      amd64) XRAY_ASSET="Xray-linux-64.zip" ;; \
      arm64) XRAY_ASSET="Xray-linux-arm64-v8a.zip" ;; \
      *) echo "unsupported TARGETARCH: '${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache --virtual .fetch curl unzip; \
    curl -fsSL --retry 3 --retry-delay 2 \
      -o /tmp/xray.zip \
      "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${XRAY_ASSET}"; \
    mkdir -p /tmp/xray-unpack; \
    unzip -q /tmp/xray.zip -d /tmp/xray-unpack; \
    install -m 0755 /tmp/xray-unpack/xray /usr/local/bin/xray; \
    rm -rf /tmp/xray.zip /tmp/xray-unpack; \
    apk del .fetch; \
    xray version

# entrypoint.sh lives at the repository root on purpose: a flat layout is much
# harder to break while uploading than a nested directory.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# Xray needs no privileges; run it unprivileged.
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
 && adduser -D -H -u 10001 xray \
 && mkdir -p /etc/xray \
 && chown xray:xray /etc/xray \
 && chmod 0750 /etc/xray
USER xray

# ---------------------------------------------------------------------------
# Defaults - override all of them in the Northflank service environment.
# PORT must match the container port you configure in Northflank.
# ---------------------------------------------------------------------------
ENV PORT=8080 \
    XHTTP_PATH=/ \
    XHTTP_MODE=packet-up \
    LOG_LEVEL=warning

EXPOSE 8080

# No Docker HEALTHCHECK on purpose: Northflank probes the container itself.
# Use a *TCP* probe on PORT - an HTTP probe cannot work here (see README).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
