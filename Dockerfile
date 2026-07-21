# Monorepo-root build context → commerce-api
FROM node:22-alpine AS deps
WORKDIR /app
COPY services/commerce-api/package.json services/commerce-api/package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY services/commerce-api/package.json services/commerce-api/package-lock.json* ./
RUN npm ci
COPY services/commerce-api/tsconfig.json ./
COPY services/commerce-api/src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY services/commerce-api/package.json ./
USER app
EXPOSE 4000
CMD ["node", "dist/index.js"]
