# syntax=docker/dockerfile:1
# =============================================================================
# BlueMap CLI renderer
# =============================================================================
# Offline world-map renderer used by BlueMapCliRenderer (shared). BlueMap runs as a
# standalone CLI (no Minecraft server required), so it is safe to use alongside
# mc-router auto-scaling.
#
# BlueMap 5.x ships as a Java 25 build (class-file major version 69), so the
# base image MUST be a Java 25 runtime. Earlier JREs fail with
# UnsupportedClassVersionError.
#
# The renderer builds the image on demand (only when missing). Run it as the
# host user so generated files stay owned by the caller:
#   docker run --rm --user "$(id -u):$(id -g)" mcctl-bluemap:<ver> -c /work/config -r -g
# =============================================================================
FROM eclipse-temurin:25-jre

# Pinned BlueMap CLI release. Bump both values together; verify the checksum
# against the GitHub release asset before changing.
ARG BLUEMAP_VERSION=5.29
ARG BLUEMAP_SHA256=e830767fa6364b52b9310fb598508ebde7eec5ebe8360a989e240d991af89a3a

ADD "https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v${BLUEMAP_VERSION}/bluemap-${BLUEMAP_VERSION}-cli.jar" \
    /opt/bluemap/bluemap-cli.jar
# Make the dir traversable and the jar world-readable so the image can run as a
# non-root host user (--user $(id -u):$(id -g)).
RUN echo "${BLUEMAP_SHA256}  /opt/bluemap/bluemap-cli.jar" | sha256sum -c - \
    && chmod 755 /opt/bluemap \
    && chmod 644 /opt/bluemap/bluemap-cli.jar

WORKDIR /work
ENTRYPOINT ["java", "-jar", "/opt/bluemap/bluemap-cli.jar"]
