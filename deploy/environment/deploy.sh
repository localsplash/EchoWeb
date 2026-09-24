#!/usr/bin/env bash
# Build and (re)deploy the live Echo stack from the checkouts in this folder.
# Each image is stamped with its own repo's commit, so /healthz reports it.
#
#   ./deploy.sh                 # all three services
#   ./deploy.sh echo-web        # just one (dependencies are left running)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

stamp() { # PREFIX REPO_DIR
  local prefix=$1 g=(git -c safe.directory=* -C "$2")
  declare -gx "${prefix}_REVISION=$("${g[@]}" rev-parse HEAD)"
  declare -gx "${prefix}_SHORT=$("${g[@]}" rev-parse --short=12 HEAD)"
  declare -gx "${prefix}_EPOCH=$("${g[@]}" show -s --format=%ct HEAD)"
  if [ -n "$("${g[@]}" status --porcelain)" ]; then
    declare -gx "${prefix}_DIRTY=true"
  else
    declare -gx "${prefix}_DIRTY=false"
  fi
  echo "$2: $("${g[@]}" branch --show-current) @ $("${g[@]}" log -1 --format='%h %cd %s' --date=iso-local)"
}

stamp ECHO_WEB EchoWeb
stamp ECHO_SERVICE EchoService
stamp ECHO_MEDIA EchoMedia

if [ $# -gt 0 ]; then
  # Targeted rebuilds skip ordinary service dependencies, but schema/account
  # jobs must still complete before an application is replaced.
  docker compose up -d echo-db-users
  job_id=$(docker compose ps -aq echo-db-users)
  job_exit=$(docker wait "$job_id")
  docker logs "$job_id"
  if [ "$job_exit" != 0 ]; then
    echo "ERROR: EchoDatabase account job exited $job_exit" >&2
    exit 1
  fi
  docker compose up -d --build --no-deps "$@"
else
  docker compose up -d --build
fi

echo "Waiting for health..."
for _ in $(seq 60); do
  states=$(docker inspect -f '{{.State.Health.Status}}' echo-web echo-service echo-media)
  if ! grep -qv healthy <<<"$states"; then
    curl -fsS http://127.0.0.1:18160/healthz && echo
    exit 0
  fi
  sleep 3
done
docker compose ps
echo "ERROR: not healthy after 180s" >&2
exit 1
