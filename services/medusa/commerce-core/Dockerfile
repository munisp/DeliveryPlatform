FROM node:22.12.0-bookworm-slim AS build
WORKDIR /srv/medusa
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY medusa-config.js tsconfig.json ./
COPY src ./src
RUN npx medusa build

FROM node:22.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/medusa
RUN useradd --system --create-home --uid 10001 medusa
COPY --from=build --chown=medusa:medusa /srv/medusa /srv/medusa
USER 10001:10001
EXPOSE 9000
CMD ["npm", "run", "start"]
