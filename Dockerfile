# Any container host: Hugging Face Spaces (Docker), Cloud Run, Fly.io, Railway
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TRUST_PROXY=true PORT=7860
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# .cache/ is written next to the app; the node user must own it
RUN mkdir -p .cache && chown -R node:node /app
USER node
EXPOSE 7860
CMD ["node", "dist/server.cjs"]
