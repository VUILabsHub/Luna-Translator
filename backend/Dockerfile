FROM golang:1.26.10-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /luna-backend .
FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -g 10001 app && adduser -D -u 10001 -G app app && mkdir /data && chown app:app /data
COPY --from=build /luna-backend /usr/local/bin/luna-backend
USER 10001:10001
VOLUME /data
EXPOSE 8080
CMD ["luna-backend"]
