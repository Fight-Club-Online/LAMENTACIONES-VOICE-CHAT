FROM node:22-slim

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install --omit=dev

# Copiar el resto del código del proyecto
COPY . .

# Exponer el puerto que tienes en tus variables (3030)
EXPOSE 3030

CMD ["npm", "start"]