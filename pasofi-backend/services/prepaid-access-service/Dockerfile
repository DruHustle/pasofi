FROM node:24.22.1-alpine
LABEL eu.onesa.product="pasofi"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
COPY --chown=node:node assets ./assets
COPY migrate.mjs ./migrate.mjs
COPY migrations ./migrations
USER node
RUN test -r assets/invoice-fonts/LiberationSans-Regular.ttf \
    && test -r assets/invoice-fonts/LiberationSans-Bold.ttf
EXPOSE 3000
CMD ["node", "dist/server.js"]
