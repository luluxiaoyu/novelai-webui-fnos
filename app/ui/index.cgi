#!/bin/bash
# NovelAI fnOS CGI Dispatcher
if ! command -v node >/dev/null 2>&1; then
    BASE_DIR="/var/apps"
    for node_dir in "${BASE_DIR}/nodejs"*/target/bin "/opt/node/bin"; do
        if [ -x "${node_dir}/node" ]; then
            export PATH="${node_dir}:$PATH"
            break
        fi
    done
fi
export PATH="/usr/local/bin:/usr/bin:$PATH"

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SOCKET_PATH="${APP_DIR}/app.sock"

# If node is available, invoke cgiHandler.js
if command -v node >/dev/null 2>&1; then
    exec node "${APP_DIR}/app/server/cgiHandler.js"
fi

echo "Status: 500 Internal Server Error"
echo "Content-Type: text/plain; charset=utf-8"
echo ""
echo "Node.js environment not found. Please install a Node.js package (e.g. nodejs_v22) from fnOS App Center or system PATH."
exit 0
