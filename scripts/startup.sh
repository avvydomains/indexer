#!/bin/sh

if [ "$RUN_INDEXER" = "1" ]; then
  (cd /app && npm run migrate)
fi

run_indexer() {
  (cd /app && node watch.js)
}

run_web() {
  (cd /app && node web.js)
}

if [ "$DEBUG" = "1" ]; then
  tail -f /dev/null
elif [ "$RUN_INDEXER" = "1" ] && [ "$RUN_WEB" = "1" ]; then
  run_indexer & run_web && fg
elif [ "$RUN_INDEXER" = "1" ]; then
  run_indexer
else
  run_web
fi
