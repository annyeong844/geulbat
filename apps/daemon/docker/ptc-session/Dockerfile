ARG PLAYWRIGHT_VERSION=1.59.1
ARG PLAYWRIGHT_IMAGE_FLAVOR=noble

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-${PLAYWRIGHT_IMAGE_FLAVOR}

ARG PLAYWRIGHT_VERSION

ENV NODE_PATH=/opt/ptcpw/node_modules \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && command -v base64 >/dev/null \
  && command -v python3 >/dev/null \
  && python3 -m pip --version >/dev/null \
  && mkdir -p /opt/ptcpw \
    /workspace \
    /geulbat/scratch/home \
    /geulbat/scratch/cache \
    /geulbat/artifacts \
    /geulbat/callback \
    /geulbat/package-cache \
  && cd /opt/ptcpw \
  && npm init -y >/dev/null \
  && npm install --omit=dev --ignore-scripts --no-audit --fund=false "playwright@${PLAYWRIGHT_VERSION}" \
  && npm cache clean --force \
  && chmod -R a+rX /opt/ptcpw /ms-playwright /workspace /geulbat

WORKDIR /workspace

CMD ["node"]
