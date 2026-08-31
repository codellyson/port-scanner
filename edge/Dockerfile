# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY dist ./dist
ENV HOST=0.0.0.0
ENV PORT=8443
EXPOSE 8443
USER node
CMD ["node", "dist/server.js"]
