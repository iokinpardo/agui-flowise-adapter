FROM node:20-alpine AS base
WORKDIR /app
COPY package.json ./
RUN npm i
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=10000
COPY --from=base /app/dist ./dist
COPY --from=base /app/package.json ./package.json
RUN npm i --omit=dev
EXPOSE 10000
CMD ["node", "dist/server.js"]
