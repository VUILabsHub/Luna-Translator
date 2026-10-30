FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY packages/core/package.json packages/core/
COPY packages/ui-shared/package.json packages/ui-shared/
RUN npm ci --no-audit --no-fund
COPY web/ web/
COPY packages/ packages/
RUN npm run build --workspace web
FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/web/dist /usr/share/nginx/html
EXPOSE 8080
