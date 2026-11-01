FROM node:24.22.1-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
