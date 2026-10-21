FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run check && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server/server.js"]
