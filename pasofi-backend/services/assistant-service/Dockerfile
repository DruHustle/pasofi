FROM node:24.22.1-alpine
LABEL eu.onesa.product="pasofi"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
COPY migrate.mjs ./migrate.mjs
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
