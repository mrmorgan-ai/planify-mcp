SHELL := /bin/bash
MCP_PORT ?= 8787
PLANIFY_URL ?= http://127.0.0.1:8788
RUN_DIR := .dev

# One process: the server runs in the real Workers runtime against a local D1
# file, and calls the planify at PLANIFY_URL — by default the one planify's own
# `make start` runs. Locally there is no Access: DEV_IDENTITY lets requests to
# 127.0.0.1 through, and no service token is sent to planify.

# Everything below is plain bash except how a port is inspected, which is the
# one thing macOS and Linux do differently. macOS keeps `lsof`, as it always
# has. Linux uses `ss`, which ships with every Ubuntu (lsof often does not), and
# falls back to lsof when ss is missing.
UNAME_S := $(shell uname -s)

ifeq ($(UNAME_S),Darwin)
  # port_busy PORT      → exit 0 when something listens on PORT
  # port_pid PORT       → the pid holding PORT
  # port_show PORT      → a line per listener, for a human
  PORT_FUNCS := \
    port_busy() { lsof -nP -iTCP:$$1 -sTCP:LISTEN >/dev/null 2>&1; }; \
    port_pid() { lsof -nP -iTCP:$$1 -sTCP:LISTEN -t | head -1; }; \
    port_show() { lsof -nP -iTCP:$$1 -sTCP:LISTEN | tail -n +2; };
else ifeq ($(UNAME_S),Linux)
  ifneq ($(shell command -v ss 2>/dev/null),)
    PORT_FUNCS := \
      port_busy() { [ -n "$$(ss -ltnH "sport = :$$1")" ]; }; \
      port_pid() { ss -ltnpH "sport = :$$1" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; }; \
      port_show() { ss -ltnpH "sport = :$$1"; };
  else
    PORT_FUNCS := \
      port_busy() { lsof -nP -iTCP:$$1 -sTCP:LISTEN >/dev/null 2>&1; }; \
      port_pid() { lsof -nP -iTCP:$$1 -sTCP:LISTEN -t | head -1; }; \
      port_show() { lsof -nP -iTCP:$$1 -sTCP:LISTEN | tail -n +2; };
  endif
else
  $(error make start/stop support macOS and Linux; this is $(UNAME_S))
endif

# A process and every descendant, deepest first. `npx` starts a chain — npm,
# a shell, node, and the workerd runtime — and on Linux killing the top of it
# leaves the rest running with the port still open.
TREE_FUNC := tree() { local child; for child in $$(pgrep -P $$1); do tree $$child; done; echo $$1; };

# The MCP handshake, used to tell that the server is up and speaking MCP.
INITIALIZE := {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"make","version":"0"}}}

.PHONY: start stop

# start: migrate the local database and run the MCP server.
start:
	@mkdir -p $(RUN_DIR)
	@$(PORT_FUNCS) \
	if port_busy $(MCP_PORT); then \
		echo "port $(MCP_PORT) is already in use:"; \
		port_show $(MCP_PORT) | sed 's/^/  /'; \
		echo "run 'make stop' if it is ours, or free it yourself if it is not."; \
		exit 1; \
	fi
	@echo "→ applying migrations to the local database"
	@npx wrangler d1 migrations apply planify-mcp --local >/dev/null 2>&1
	@echo "→ starting the MCP server on $(MCP_PORT)"
	@# The host is explicit: left to itself wrangler may bind "localhost", which
	@# Ubuntu resolves to ::1 only, and the check below — and the URL printed at
	@# the end — are on 127.0.0.1.
	@npx wrangler dev --ip 127.0.0.1 --port $(MCP_PORT) --show-interactive-dev-session=false \
		--var DEV_IDENTITY:dev@localhost --var PLANIFY_URL:$(PLANIFY_URL) \
		> $(RUN_DIR)/mcp.log 2>&1 & echo $$! > $(RUN_DIR)/mcp.pid
	@ready=1; \
	for i in $$(seq 1 60); do \
		curl -s --max-time 2 -H 'Content-Type: application/json' -d '$(INITIALIZE)' \
			http://127.0.0.1:$(MCP_PORT)/mcp 2>/dev/null | grep -q '"protocolVersion"' && { ready=0; break; }; \
		sleep 1; \
	done; \
	if [ $$ready -ne 0 ]; then \
		echo "the MCP server never answered on $(MCP_PORT). Last lines of $(RUN_DIR)/mcp.log:"; \
		tail -n 15 $(RUN_DIR)/mcp.log | sed 's/^/  /'; \
		exit 1; \
	fi
	@# The server starts without planify, but every tool call would fail.
	@echo; \
	if curl -s --max-time 2 $(PLANIFY_URL)/api/health >/dev/null 2>&1; then \
		echo "planify answers at $(PLANIFY_URL)"; \
	else \
		echo "planify does not answer at $(PLANIFY_URL): tool calls will fail until it does."; \
		echo "  start it with 'make start' in the planify repo"; \
	fi
	@echo "mcp  http://127.0.0.1:$(MCP_PORT)/mcp"
	@echo "logs $(RUN_DIR)/mcp.log"

# stop: stop only what start launched. Never a broad pkill: a development
# machine usually has other servers running, and some of them are on this port.
stop:
	@$(TREE_FUNC) \
	file=$(RUN_DIR)/mcp.pid; \
	stopped=0; \
	if [ -f "$$file" ]; then \
		pid=$$(cat $$file); \
		if kill -0 $$pid 2>/dev/null; then \
			if ps -p $$pid -o command= | grep -q 'wrangler'; then \
				kill $$(tree $$pid) 2>/dev/null || true; \
				echo "stopped mcp (pid $$pid)"; \
				stopped=1; \
			else \
				echo "pid $$pid is no longer ours — leaving it alone"; \
			fi; \
		fi; \
		rm -f $$file; \
	fi; \
	[ $$stopped -eq 1 ] || echo "nothing of ours was running"
	@# A child can outlive the parent we just killed. The port is the honest
	@# check, and only a process from this project's node_modules is ever
	@# escalated to SIGKILL.
	@$(PORT_FUNCS) \
	for i in 1 2 3 4 5; do \
		port_busy $(MCP_PORT) || break; \
		sleep 1; \
	done; \
	if port_busy $(MCP_PORT); then \
		holder=$$(port_pid $(MCP_PORT)); \
		if [ -z "$$holder" ]; then \
			echo "port $(MCP_PORT) is held by a process this user cannot see:"; \
			port_show $(MCP_PORT) | sed 's/^/  /'; \
		elif ps -p $$holder -o command= | grep -q "$(CURDIR)/node_modules"; then \
			kill -9 $$holder 2>/dev/null || true; \
			echo "port $(MCP_PORT) needed SIGKILL (pid $$holder)"; \
		else \
			echo "port $(MCP_PORT) is held by a process we did not start:"; \
			ps -p $$holder -o pid=,command= | cut -c1-120 | sed 's/^/  /'; \
		fi; \
	fi
