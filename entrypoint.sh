#!/bin/sh
set -eu
umask 027
if [ "$#" -gt 0 ]; then
    exec "$@"
fi
# Validation, bounded DB readiness, schema creation and credential migration are
# performed before server.js opens its socket. A single process owns its cache.
exec node server.js
