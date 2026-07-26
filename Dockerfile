# 容器化部署（Docker / 任意支持容器的云平台）
FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
