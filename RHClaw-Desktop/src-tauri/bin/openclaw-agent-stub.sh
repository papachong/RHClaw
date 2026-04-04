#!/usr/bin/env sh

printf '[startup] RHOpenClaw Agent stub booting\n'

count=0
while true; do
  count=$((count + 1))
  printf '[heartbeat] tick=%s status=alive\n' "$count"
  sleep 5
done
