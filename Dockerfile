FROM oven/bun:1.2.18-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
ENV CLAUDE_CLI_PATH=/app/bin/claude-haha

FROM base AS deps
RUN apk add --no-cache git openssh-client bash ripgrep
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY adapters/package.json adapters/bun.lock ./adapters/
RUN cd adapters && bun install --frozen-lockfile && cp -a node_modules/. ../node_modules/

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/adapters/node_modules ./adapters/node_modules
COPY . .
RUN BUN_CONFIG_FILE=./docker-bunfig.toml bun build ./src/server/index.ts --target=bun --outfile=./dist/server.js --packages=external
RUN bun build ./scripts/maxkb-openai-bridge.ts --target=bun --outfile=./dist/maxkb-openai-bridge.js

FROM base AS runtime
ENV BUN_OPTIONS=--preload=/app/scripts/docker-cli-macro-preload.ts
RUN apk add --no-cache git openssh-client bash ripgrep ca-certificates python3
RUN addgroup -S cchaha && adduser -S -G cchaha -h /home/cchaha cchaha
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/adapters/node_modules ./adapters/node_modules
COPY --from=build /app/dist ./dist
COPY src ./src
COPY adapters ./adapters
COPY runtime ./runtime
COPY scripts ./scripts
COPY preload.ts ./preload.ts
COPY bin ./bin
COPY stubs ./stubs
COPY package.json ./package.json
COPY docker-bunfig.toml ./docker-bunfig.toml
RUN find ./bin -type f -name 'claude-haha' -exec sed -i 's/\r$//' {} + && chmod +x ./bin/claude-haha && ln -s ../src ./node_modules/src && mkdir -p ./node_modules/@ant/claude-for-chrome-mcp ./node_modules/color-diff-napi && printf '{"type":"module","main":"./index.ts"}\n' > ./node_modules/@ant/claude-for-chrome-mcp/package.json && printf '{"type":"module","main":"./index.ts"}\n' > ./node_modules/color-diff-napi/package.json && ln -s /app/stubs/ant-claude-for-chrome-mcp.ts ./node_modules/@ant/claude-for-chrome-mcp/index.ts && ln -s /app/stubs/color-diff-napi.ts ./node_modules/color-diff-napi/index.ts && ln -s ../scripts/docker-bun-bundle-shim.ts ./node_modules/bundle && chown -R cchaha:cchaha /home/cchaha
USER cchaha
EXPOSE 3456
EXPOSE 8000
CMD ["bun", "./dist/server.js"]
