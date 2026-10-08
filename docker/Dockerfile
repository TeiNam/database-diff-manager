# syntax=docker/dockerfile:1
# Database Diff — 빌드 컨텍스트는 저장소 루트: docker build -f docker/Dockerfile .

# 1) 웹 빌드: 개발 의존성까지 설치해 apps/web/dist 를 만든다
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/core packages/core
COPY apps/web apps/web
# CI 가 넘기는 제품 버전 (화면 상단·푸터에 표시). 로컬 빌드는 package.json 버전 + -dev
ARG APP_VERSION=
RUN APP_VERSION="$APP_VERSION" npm run build -w @tdm/web

# 2) 실행 이미지: 서버·core 의 운영 의존성만 설치하고 빌드된 웹만 복사한다
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# ponytail: 서버는 tsx 로 TS 를 바로 실행한다(사전 컴파일 단계 없음). 시작 시간이 문제되면 tsc 빌드로 바꾼다
RUN npm ci --omit=dev -w @tdm/server -w @tdm/core && npm cache clean --force
COPY packages/core packages/core
COPY apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/apps/server
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
