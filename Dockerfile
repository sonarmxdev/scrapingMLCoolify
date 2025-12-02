FROM node:18-slim

# Instalar Chromium mínimo
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Usar npm install simple
RUN npm install

COPY . .

EXPOSE 3000

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "escuchar.js"]
