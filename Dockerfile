FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB=/data/chuvicka.db PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
