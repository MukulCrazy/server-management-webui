FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && rm -rf /root/.npm

COPY . .

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]