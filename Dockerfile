FROM node:20-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
