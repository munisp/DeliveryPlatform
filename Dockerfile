FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile \
    && useradd --system --uid 10001 --create-home switchos
COPY --from=build /app/dist ./dist
USER 10001:10001
EXPOSE 3005
CMD ["node", "dist/index.js"]
