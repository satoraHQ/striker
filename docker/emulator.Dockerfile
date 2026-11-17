FROM golang:1.26.9 AS build
WORKDIR /app
# Exact v0.0.9-rc.2 source, with an archive checksum to pin its contents.
ADD --checksum=sha256:6b0daef7a5e3d68ea5fa681c5422ce9aa7c212d4a9c7ec6100ac9dccf4c9ad7c https://codeload.github.com/arkade-os/emulator/tar.gz/fb1992c7d5ba2068753ca7aebffd7110674cfbd8 /tmp/emulator.tar.gz
RUN tar -xzf /tmp/emulator.tar.gz --strip-components=1 -C /app
COPY docker/emulator-checkpoints.patch /tmp/checkpoints.patch
RUN git apply /tmp/checkpoints.patch
RUN go test ./internal/application -run TestMergeCheckpointSignatures -count=1
RUN CGO_ENABLED=0 go build -ldflags="-X main.Version=v0.0.9-rc.2-striker.1" -o /tmp/emulator ./cmd/emulator.go
FROM ghcr.io/arkade-os/emulator:v0.0.9-rc.2
COPY --from=build /tmp/emulator /app/emulator
