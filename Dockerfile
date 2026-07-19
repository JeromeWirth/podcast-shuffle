FROM node:22-alpine
WORKDIR /app

# Install deps first so code changes don't bust the npm cache layer
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev

COPY server/ server/
COPY client/public/ client/public/

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/server.js"]
