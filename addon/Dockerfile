# Stremio addon — multi-stage build (spec section 6).
#
# Node 22: Node 20 reached end of life in April 2026.
# The 256 MB memory ceiling (N6) is enforced by compose's mem_limit, not here.

FROM node:22-alpine AS build

# better-sqlite3 is a native module and publishes no musl prebuilds, so it is
# compiled from source here. These toolchain packages stay in the build stage.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --include=dev; else npm install --include=dev; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies but keep the compiled better-sqlite3 binding.
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The `node` user is uid/gid 1000, matching PUID/PGID in .env (section 3.3), so
# the bind-mounted /config is writable and /data/media is readable.
USER node

EXPOSE 7000

CMD ["node", "dist/index.js"]
