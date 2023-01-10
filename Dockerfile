FROM alpine:3.17.0

RUN apk add --update nodejs npm sqlite
COPY app /app
COPY scripts/startup.sh /
RUN (cd /app && npm install)
ENV RUN_INDEXER=0
ENV RUN_WEB=0
ENV NODE_ENV=development
ENV DEBUG=0
ENV CONFIG="not set"
CMD ["/bin/sh", "/startup.sh"]

