FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27.1-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -o /golf ./cmd/golf

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S golf && adduser -S -G golf golf
WORKDIR /app
COPY --from=server /golf /usr/local/bin/golf
COPY --from=web /src/web/dist ./web/dist
USER golf
EXPOSE 8080
ENTRYPOINT ["golf"]
