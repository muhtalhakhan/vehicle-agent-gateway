#!/usr/bin/env bash
# Run the gateway on a local Kubernetes cluster (kind) and smoke-test it through the cluster.
#   ./scripts/k8s-local.sh          create cluster, build, deploy, test, leave it running
#   ./scripts/k8s-local.sh down     delete the cluster
set -euo pipefail

CLUSTER=vehicle-gateway
NS=vehicle-gateway
IMAGE=vehicle-agent-gateway:local
PORT=${PORT:-8090}
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "down" ]]; then kind delete cluster --name "$CLUSTER"; exit 0; fi

for tool in docker kind kubectl; do
  command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
done

kind get clusters | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s
kubectl config use-context "kind-$CLUSTER" >/dev/null

echo "==> build + load image"
docker build -q -t "$IMAGE" . >/dev/null
kind load docker-image "$IMAGE" --name "$CLUSTER"

SECRETS=deploy/k8s/secrets.env
if [[ ! -f "$SECRETS" ]]; then
  echo "==> generating $SECRETS (git-ignored)"
  CLIENT_SECRET=$(openssl rand -hex 24)
  {
    echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "CLIENTS_JSON={\"local-assistant\":{\"secret\":\"$CLIENT_SECRET\",\"scopes\":[\"vehicle:read\",\"vehicle:control\"]}}"
  } > "$SECRETS"
  chmod 600 "$SECRETS"
fi

echo "==> deploy"
kubectl apply -k deploy/k8s
kubectl -n "$NS" set env deployment/gateway PUBLIC_URL="http://localhost:$PORT" >/dev/null
kubectl -n "$NS" rollout status deployment/gateway --timeout=120s

echo "==> port-forward localhost:$PORT -> service/gateway"
kubectl -n "$NS" port-forward service/gateway "$PORT:80" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "localhost:$PORT/health" >/dev/null && break; sleep 1; done

echo "==> smoke test"
CLIENT=$(sed -n 's/^CLIENTS_JSON={"\([^"]*\)".*/\1/p' "$SECRETS")
SECRET=$(sed -n 's/.*"secret":"\([^"]*\)".*/\1/p' "$SECRETS")
B="http://localhost:$PORT"
fail() { echo "FAIL: $*"; kubectl -n "$NS" logs deployment/gateway --tail=50; exit 1; }

[[ $(curl -s "$B/health") == '{"ok":true}' ]] || fail "health"
TOKEN=$(curl -s -u "$CLIENT:$SECRET" -d grant_type=client_credentials "$B/oauth/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[[ -n "$TOKEN" ]] || fail "token"
[[ $(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp") == 401 ]] || fail "unauthenticated MCP not rejected"
TOOLS=$(curl -s "$B/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | wc -l | tr -d ' ')
[[ "$TOOLS" == 6 ]] || fail "expected 6 MCP tools, got $TOOLS"
[[ $(curl -s "$B/.well-known/agent-card.json" | grep -c '"url":"http://localhost:'"$PORT"'/a2a"') == 1 ]] || fail "agent card URL"
curl -s "$B/" | grep -q "Try it" && fail "demo panel must be hidden with real clients"
echo "PASS: health, OAuth token, 401 without token, 6 MCP tools, agent card, no demo credentials"

echo
kubectl -n "$NS" get pods -o wide
echo
echo "Running in kind. Reach it with: kubectl -n $NS port-forward service/gateway $PORT:80"
echo "Client credentials are in $SECRETS. Remove everything with: $0 down"
