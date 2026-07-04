# Build the game + run the multiplayer server (static files + /ws relay).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# ws is the server's only runtime dependency (zero transitive hard deps)
COPY --from=build /app/node_modules/ws ./node_modules/ws
EXPOSE 8787
CMD ["node", "server/server.mjs"]
