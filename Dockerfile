FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-trixie-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# After installing, remove npm/corepack/yarn from the runtime image: the
# container only ever runs `node`, and the bundled package managers drag
# their own dependency trees (pacote, sigstore, …) through every CVE scan.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*
COPY --from=build /app/build ./build
EXPOSE 8081
CMD ["node", "build/index.js"]
