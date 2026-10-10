# Dev-stack worker image (infra/dev/compose.yml). Prod runs the same binary
# under host systemd, built by infra/worker/restart.sh.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY apps/worker/go.mod apps/worker/go.sum ./
RUN go mod download
COPY apps/worker/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/homehost-worker .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/homehost-worker /usr/local/bin/homehost-worker
ENTRYPOINT ["/usr/local/bin/homehost-worker"]
