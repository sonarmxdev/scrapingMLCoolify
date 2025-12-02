FROM node:18-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install --only=production

# Copiar el código de la aplicación
COPY . .

# Exponer el puerto
EXPOSE 3000

# Comando para iniciar
CMD ["node", "escuchar.js"]
