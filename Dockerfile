FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json server.js worker.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data /app/storage/buckets/items && \
    chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    BUCKET_DIR=/app/storage/buckets/items

EXPOSE 3000

CMD ["node", "server.js"]
