# syntax=docker/dockerfile:1
# One image: the Python server serving the built editor. Tests run during the build, so a failing test means no image.
#   docker build --build-arg RUN_TESTS=0 .   skips the tests (deploy.sh --skip-tests)

# ---- editor: install, test, build -------------------------------------------------------------
FROM node:20-alpine AS editor
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
ARG RUN_TESTS=1
# These are baked into the editor. Never leave them empty: an empty value would beat the editor's built-in default.
ARG VITE_DINO_ISSUER=https://dino.mr-salih.org
ARG VITE_DINO_CLIENT_ID=map-editor
ARG VITE_API_URL=
ENV VITE_DINO_ISSUER=$VITE_DINO_ISSUER VITE_DINO_CLIENT_ID=$VITE_DINO_CLIENT_ID VITE_API_URL=$VITE_API_URL
RUN if [ "$RUN_TESTS" = "1" ]; then npx vitest run; fi
RUN npx tsc --noEmit && npx vite build

# ---- server tests -------------------------------------------------------------------------------
FROM python:3.12-slim AS server-test
WORKDIR /app/server
COPY server/pyproject.toml ./
COPY server/mapserver ./mapserver
RUN pip install --no-cache-dir ".[dev]"
COPY server/tests ./tests
ARG RUN_TESTS=1
RUN if [ "$RUN_TESTS" = "1" ]; then python -m pytest -q; fi && touch /tests-ok

# ---- runtime ------------------------------------------------------------------------------------
FROM python:3.12-slim
LABEL app=map-editor
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    MAP_HOST=0.0.0.0 MAP_PORT=5000 MAP_DB_PATH=/data/maps.db MAP_STATIC_DIR=/app/dist
RUN useradd --system --uid 10001 --home-dir /app app && mkdir -p /data && chown app /data
WORKDIR /app/server
COPY server/pyproject.toml ./
COPY server/mapserver ./mapserver
RUN pip install --no-cache-dir .
COPY server/run.py ./
COPY --from=editor /app/dist /app/dist
# Without this the tests stage would be skipped by BuildKit, because nothing else reads from it.
COPY --from=server-test /tests-ok /tests-ok
USER app
VOLUME /data
EXPOSE 5000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('MAP_PORT','5000'), timeout=2)"
CMD ["python", "run.py"]
