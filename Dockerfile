FROM node:18-alpine

WORKDIR /app

# Instalar dependencias necesarias para Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji

# Indicar a Puppeteer usar Chromium instalado
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm ci --only=production

# Copiar el código de la aplicación
COPY . .

# Exponer puerto
EXPOSE 3000

# Comando para iniciar
CMD ["node", "escuchar.js"]
