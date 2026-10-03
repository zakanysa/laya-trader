FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY laya/question.json ./laya/question.json
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
