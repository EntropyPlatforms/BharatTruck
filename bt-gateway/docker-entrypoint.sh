#!/bin/sh
# Explicit variable list required — envsubst without it would replace nginx's own $host, $remote_addr, etc.
set -e

# Every *_SERVICE_URL lands in an nginx `set $x ${VAR};` directive, so an UNSET var substitutes to
# `set $x ;` — "invalid number of arguments", and nginx refuses to start. That fails CLOSED on the
# whole gateway: one missing var takes every app down, not just the route that needed it. Default
# each to an unroutable placeholder so a missing var degrades to a 502 on that one location instead.
# NOTE: these must be EXPORTed, not just set — envsubst is a child process and only reads the
# environment. An unset DNS_RESOLVER is fatal too ("no name servers defined" on the resolver line).
export DNS_RESOLVER="${DNS_RESOLVER:-8.8.8.8}"
export CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-*}"
for _v in AUTH_SERVICE_URL BOOKING_SERVICE_URL TRACKING_SERVICE_URL PRICING_SERVICE_URL \
          PAYMENT_SERVICE_URL CARGO_SERVICE_URL FLEET_SERVICE_URL; do
  eval "_cur=\${$_v:-}"
  if [ -z "$_cur" ]; then
    echo "WARN: $_v is unset — /api routes needing it will return 502" >&2
    eval "export $_v=http://127.0.0.1:1"
  fi
done

envsubst '${DNS_RESOLVER} ${AUTH_SERVICE_URL} ${BOOKING_SERVICE_URL} ${TRACKING_SERVICE_URL} ${PRICING_SERVICE_URL} ${PAYMENT_SERVICE_URL} ${CARGO_SERVICE_URL} ${FLEET_SERVICE_URL} ${CORS_ALLOWED_ORIGINS}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
