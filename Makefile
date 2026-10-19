BASE  := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))/
SHELL := /bin/bash

# ─── Service lists ────────────────────────────────────────────────────────────
BACKEND_SVCS  := bt-auth-service bt-booking-service bt-pricing-service bt-payment-service bt-cargo-ledger
FRONTEND_SVCS := bt-ops-web bt-driver-app bt-shipper-app
ALL_SVCS      := $(BACKEND_SVCS) $(FRONTEND_SVCS)

# ─── Colors ───────────────────────────────────────────────────────────────────
RESET  := \033[0m
BOLD   := \033[1m
DIM    := \033[2m
GREEN  := \033[32m
YELLOW := \033[33m
CYAN   := \033[36m
RED    := \033[31m

.PHONY: help install install-all redis \
        start start-auth start-booking start-pricing start-payment start-cargo start-admin \
        start-driver start-shipper \
        stop \
        restart-auth restart-booking restart-pricing restart-payment restart-cargo restart-admin \
        health status \
        logs logs-auth logs-booking logs-pricing logs-payment logs-cargo logs-admin \
        test-auth test-pricing test-cargo \
        git-status git-log \
        clean

# ─── Default ──────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "$(BOLD)BharatTruck / LogisticOS — Dev Commands$(RESET)"
	@echo "──────────────────────────────────────────────────────────"
	@echo "$(CYAN)Setup$(RESET)"
	@echo "  make install         Install deps for all backend services"
	@echo "  make install-all     Install deps for ALL services (incl. frontends + mobile)"
	@echo "  make redis           Start Redis locally (brew)"
	@echo ""
	@echo "$(CYAN)Start Services$(RESET)"
	@echo "  make start           Start all 6 web services in background + health check"
	@echo "  make start-auth      Start bt-auth-service       :3001  (foreground)"
	@echo "  make start-booking   Start bt-booking-service    :3002  (foreground)"
	@echo "  make start-pricing   Start bt-pricing-service    :3003  (foreground)"
	@echo "  make start-payment   Start bt-payment-service    :3004  (foreground)"
	@echo "  make start-cargo     Start bt-cargo-ledger       :3005  (foreground)"
	@echo "  make start-admin     Start bt-ops-web            :3000  (foreground)"
	@echo "  make start-driver    Start bt-driver-app  (Expo)"
	@echo "  make start-shipper   Start bt-shipper-app (Expo)"
	@echo ""
	@echo "$(CYAN)Restart Services$(RESET)"
	@echo "  make restart-auth    Restart bt-auth-service"
	@echo "  make restart-booking Restart bt-booking-service"
	@echo "  make restart-pricing Restart bt-pricing-service"
	@echo "  make restart-payment Restart bt-payment-service"
	@echo "  make restart-cargo   Restart bt-cargo-ledger"
	@echo "  make restart-admin   Restart bt-ops-web"
	@echo ""
	@echo "$(CYAN)Observe$(RESET)"
	@echo "  make health          Hit /health on all 6 web services"
	@echo "  make status          Per-service: port, PID, UP/DOWN, health"
	@echo "  make logs            Tail ALL service logs  (Ctrl+C to stop)"
	@echo "  make logs-auth       Tail bt-auth-service log"
	@echo "  make logs-booking    Tail bt-booking-service log"
	@echo "  make logs-pricing    Tail bt-pricing-service log"
	@echo "  make logs-payment    Tail bt-payment-service log"
	@echo "  make logs-cargo      Tail bt-cargo-ledger log"
	@echo "  make logs-admin      Tail bt-ops-web log"
	@echo ""
	@echo "$(CYAN)Test$(RESET)"
	@echo "  make test-auth       Quick OTP flow test"
	@echo "  make test-pricing    Quick pricing quote test"
	@echo "  make test-cargo      Quick cargo checkpoint test"
	@echo ""
	@echo "$(CYAN)Git$(RESET)"
	@echo "  make git-status      git status across all repos"
	@echo "  make git-log         Recent commits across all repos"
	@echo ""
	@echo "$(CYAN)Cleanup$(RESET)"
	@echo "  make stop            Kill all running background services"
	@echo "  make clean           Remove node_modules from ALL services"
	@echo ""
	@echo "$(DIM)Tip: Use ./bt for a friendlier CLI wrapper around these targets.$(RESET)"
	@echo ""

# ─── Setup ────────────────────────────────────────────────────────────────────
install:
	@echo "$(CYAN)Installing backend dependencies...$(RESET)"
	@for svc in $(BACKEND_SVCS); do \
		echo "  → $$svc"; \
		cd $(BASE)$$svc && npm install --silent; \
	done
	@echo "$(GREEN)✓ Backend dependencies installed$(RESET)"

install-all:
	@echo "$(CYAN)Installing ALL service dependencies...$(RESET)"
	@for svc in $(ALL_SVCS); do \
		echo "  → $$svc"; \
		cd $(BASE)$$svc && npm install --silent; \
	done
	@echo "$(GREEN)✓ All dependencies installed$(RESET)"

redis:
	@echo "$(CYAN)Starting Redis...$(RESET)"
	@redis-cli ping > /dev/null 2>&1 && echo "$(GREEN)✓ Redis already running$(RESET)" || \
		(redis-server --daemonize yes --logfile /tmp/redis-bt.log && sleep 1 && echo "$(GREEN)✓ Redis started$(RESET)")

# ─── Individual Services (foreground) ─────────────────────────────────────────
start-auth:
	@echo "$(CYAN)Starting bt-auth-service on :3001...$(RESET)"
	@cd $(BASE)bt-auth-service && \
		[ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3001 NODE_ENV=development OTP_DEV_MODE=true \
		SUPABASE_URL=$${SUPABASE_URL:-http://localhost:54321} \
		SUPABASE_SERVICE_ROLE_KEY=$${SUPABASE_SERVICE_ROLE_KEY:-dev-stub-key} \
		REDIS_URL=$${REDIS_URL:-redis://localhost:6379} \
		JWT_SECRET=$${JWT_SECRET:-dev-jwt-secret-long-enough-for-local} \
		JWT_REFRESH_SECRET=$${JWT_REFRESH_SECRET:-dev-refresh-secret-long-enough} \
		node_modules/.bin/tsx watch src/index.ts

start-booking:
	@echo "$(CYAN)Starting bt-booking-service on :3002...$(RESET)"
	@cd $(BASE)bt-booking-service && \
		[ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3002 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts

start-pricing:
	@echo "$(CYAN)Starting bt-pricing-service on :3003...$(RESET)"
	@cd $(BASE)bt-pricing-service && \
		PORT=3003 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts

start-payment:
	@echo "$(CYAN)Starting bt-payment-service on :3004...$(RESET)"
	@cd $(BASE)bt-payment-service && \
		[ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3004 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts

start-cargo:
	@echo "$(CYAN)Starting bt-cargo-ledger on :3005...$(RESET)"
	@cd $(BASE)bt-cargo-ledger && \
		PORT=3005 NODE_ENV=development BLOCKCHAIN_ENABLED=false \
		node_modules/.bin/tsx watch src/index.ts

start-admin:
	@echo "$(CYAN)Starting bt-ops-web on :3000...$(RESET)"
	@cd $(BASE)bt-ops-web && npm run dev

start-driver:
	@echo "$(CYAN)Starting bt-driver-app (Expo)...$(RESET)"
	@cd $(BASE)bt-driver-app && npx expo start

start-shipper:
	@echo "$(CYAN)Starting bt-shipper-app (Expo)...$(RESET)"
	@cd $(BASE)bt-shipper-app && npx expo start

# ─── Start All (background) ───────────────────────────────────────────────────
start: redis
	@echo "$(CYAN)Starting all 6 web services in background...$(RESET)"
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-auth-service && \
		( [ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3001 NODE_ENV=development OTP_DEV_MODE=true \
		SUPABASE_URL=$${SUPABASE_URL:-http://localhost:54321} \
		SUPABASE_SERVICE_ROLE_KEY=$${SUPABASE_SERVICE_ROLE_KEY:-dev-stub-key} \
		REDIS_URL=$${REDIS_URL:-redis://localhost:6379} \
		JWT_SECRET=$${JWT_SECRET:-dev-jwt-secret-long-enough-for-local} \
		JWT_REFRESH_SECRET=$${JWT_REFRESH_SECRET:-dev-refresh-secret-long-enough} \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/auth.log 2>&1 ) & \
		echo $$! > /tmp/bt-auth.pid
	@cd $(BASE)bt-booking-service && \
		( [ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3002 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/booking.log 2>&1 ) & \
		echo $$! > /tmp/bt-booking.pid
	@cd $(BASE)bt-pricing-service && \
		( PORT=3003 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/pricing.log 2>&1 ) & \
		echo $$! > /tmp/bt-pricing.pid
	@cd $(BASE)bt-payment-service && \
		( [ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3004 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/payment.log 2>&1 ) & \
		echo $$! > /tmp/bt-payment.pid
	@cd $(BASE)bt-cargo-ledger && \
		( PORT=3005 NODE_ENV=development BLOCKCHAIN_ENABLED=false \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/cargo.log 2>&1 ) & \
		echo $$! > /tmp/bt-cargo.pid
	@cd $(BASE)bt-ops-web && \
		( npm run dev > /tmp/bt-logs/admin.log 2>&1 ) & \
		echo $$! > /tmp/bt-admin.pid
	@sleep 4
	@$(MAKE) health

# ─── Stop ─────────────────────────────────────────────────────────────────────
stop:
	@echo "$(YELLOW)Stopping all services...$(RESET)"
	@for f in /tmp/bt-auth.pid /tmp/bt-booking.pid /tmp/bt-pricing.pid \
	           /tmp/bt-payment.pid /tmp/bt-cargo.pid /tmp/bt-admin.pid; do \
		[ -f $$f ] && kill $$(cat $$f) 2>/dev/null && rm $$f || true; \
	done
	@pkill -f "tsx watch src/index.ts" 2>/dev/null || true
	@pkill -f "next dev" 2>/dev/null || true
	@echo "$(GREEN)✓ All services stopped$(RESET)"

# ─── Restart (kill PID then relaunch in background) ───────────────────────────
restart-auth:
	@[ -f /tmp/bt-auth.pid ] && kill $$(cat /tmp/bt-auth.pid) 2>/dev/null && rm /tmp/bt-auth.pid || true
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-auth-service && \
		( [ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3001 NODE_ENV=development OTP_DEV_MODE=true \
		SUPABASE_URL=$${SUPABASE_URL:-http://localhost:54321} \
		SUPABASE_SERVICE_ROLE_KEY=$${SUPABASE_SERVICE_ROLE_KEY:-dev-stub-key} \
		REDIS_URL=$${REDIS_URL:-redis://localhost:6379} \
		JWT_SECRET=$${JWT_SECRET:-dev-jwt-secret-long-enough-for-local} \
		JWT_REFRESH_SECRET=$${JWT_REFRESH_SECRET:-dev-refresh-secret-long-enough} \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/auth.log 2>&1 ) & \
		echo $$! > /tmp/bt-auth.pid
	@echo "$(GREEN)✓ bt-auth-service restarted (PID $$(cat /tmp/bt-auth.pid))$(RESET)"

restart-booking:
	@[ -f /tmp/bt-booking.pid ] && kill $$(cat /tmp/bt-booking.pid) 2>/dev/null && rm /tmp/bt-booking.pid || true
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-booking-service && \
		( [ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3002 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/booking.log 2>&1 ) & \
		echo $$! > /tmp/bt-booking.pid
	@echo "$(GREEN)✓ bt-booking-service restarted (PID $$(cat /tmp/bt-booking.pid))$(RESET)"

restart-pricing:
	@[ -f /tmp/bt-pricing.pid ] && kill $$(cat /tmp/bt-pricing.pid) 2>/dev/null && rm /tmp/bt-pricing.pid || true
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-pricing-service && \
		( PORT=3003 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/pricing.log 2>&1 ) & \
		echo $$! > /tmp/bt-pricing.pid
	@echo "$(GREEN)✓ bt-pricing-service restarted (PID $$(cat /tmp/bt-pricing.pid))$(RESET)"

restart-payment:
	@[ -f /tmp/bt-payment.pid ] && kill $$(cat /tmp/bt-payment.pid) 2>/dev/null && rm /tmp/bt-payment.pid || true
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-payment-service && \
		( [ -f .env ] && export $$(cat .env | grep -v '^#' | xargs) || true; \
		PORT=3004 NODE_ENV=development \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/payment.log 2>&1 ) & \
		echo $$! > /tmp/bt-payment.pid
	@echo "$(GREEN)✓ bt-payment-service restarted (PID $$(cat /tmp/bt-payment.pid))$(RESET)"

restart-cargo:
	@[ -f /tmp/bt-cargo.pid ] && kill $$(cat /tmp/bt-cargo.pid) 2>/dev/null && rm /tmp/bt-cargo.pid || true
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-cargo-ledger && \
		( PORT=3005 NODE_ENV=development BLOCKCHAIN_ENABLED=false \
		node_modules/.bin/tsx watch src/index.ts > /tmp/bt-logs/cargo.log 2>&1 ) & \
		echo $$! > /tmp/bt-cargo.pid
	@echo "$(GREEN)✓ bt-cargo-ledger restarted (PID $$(cat /tmp/bt-cargo.pid))$(RESET)"

restart-admin:
	@[ -f /tmp/bt-admin.pid ] && kill $$(cat /tmp/bt-admin.pid) 2>/dev/null && rm /tmp/bt-admin.pid || true
	@pkill -f "next dev" 2>/dev/null || true
	@mkdir -p /tmp/bt-logs
	@cd $(BASE)bt-ops-web && \
		( npm run dev > /tmp/bt-logs/admin.log 2>&1 ) & \
		echo $$! > /tmp/bt-admin.pid
	@echo "$(GREEN)✓ bt-ops-web restarted (PID $$(cat /tmp/bt-admin.pid))$(RESET)"

# ─── Status ───────────────────────────────────────────────────────────────────
status:
	@echo ""
	@echo "$(BOLD)Service Status$(RESET)"
	@printf "$(BOLD)%-22s %-6s %-8s %-12s %s$(RESET)\n" "SERVICE" "PORT" "PID" "STATE" "HEALTH"
	@echo "──────────────────────────────────────────────────────────────────"
	@_bt_row() { \
		svc=$$1; port=$$2; pidfile=$$3; \
		if [ -f "$$pidfile" ] && kill -0 $$(cat "$$pidfile") 2>/dev/null; then \
			pid=$$(cat "$$pidfile"); \
			state="$(GREEN)RUNNING$(RESET)"; \
		else \
			pid="—"; \
			state="$(RED)STOPPED$(RESET)"; \
		fi; \
		if [ -n "$$port" ] && [ "$$port" != "—" ]; then \
			health=$$(curl -sf --max-time 1 http://localhost:$$port/health 2>/dev/null \
				| python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null \
				|| echo "$(RED)unreachable$(RESET)"); \
		else \
			health="$(DIM)N/A$(RESET)"; \
		fi; \
		printf "%-22s %-6s %-8s %-22s %s\n" "$$svc" "$${port:-—}" "$$pid" "$$state" "$$health"; \
	}; \
	_bt_row bt-auth-service    3001 /tmp/bt-auth.pid; \
	_bt_row bt-booking-service 3002 /tmp/bt-booking.pid; \
	_bt_row bt-pricing-service 3003 /tmp/bt-pricing.pid; \
	_bt_row bt-payment-service 3004 /tmp/bt-payment.pid; \
	_bt_row bt-cargo-ledger    3005 /tmp/bt-cargo.pid; \
	_bt_row bt-ops-web         3000 /tmp/bt-admin.pid; \
	_bt_row bt-driver-app      —    /dev/null; \
	_bt_row bt-shipper-app     —    /dev/null
	@echo ""

# ─── Health Checks ────────────────────────────────────────────────────────────
health:
	@echo ""
	@echo "$(BOLD)Service Health$(RESET)"
	@echo "──────────────────────────────────────────────"
	@for port_svc in "3000:ops-web" "3001:auth-service" "3002:booking-service" \
	                  "3003:pricing-service" "3004:payment-service" "3005:cargo-ledger"; do \
		port=$${port_svc%%:*}; svc=$${port_svc##*:}; \
		result=$$(curl -sf --max-time 2 http://localhost:$$port/health 2>/dev/null); \
		if [ $$? -eq 0 ]; then \
			echo "  $(GREEN)✓$(RESET) bt-$$svc  :$$port  UP"; \
		else \
			echo "  $(RED)✗$(RESET) bt-$$svc  :$$port  DOWN"; \
		fi; \
	done
	@echo ""

# ─── Logs ─────────────────────────────────────────────────────────────────────
logs:
	@echo "$(BOLD)Live logs — all services$(RESET)  (Ctrl+C to stop)"
	@tail -f /tmp/bt-logs/*.log 2>/dev/null || echo "$(RED)No services running. Run: make start$(RESET)"

logs-auth:
	@tail -f /tmp/bt-logs/auth.log 2>/dev/null || echo "$(RED)bt-auth-service not running$(RESET)"

logs-booking:
	@tail -f /tmp/bt-logs/booking.log 2>/dev/null || echo "$(RED)bt-booking-service not running$(RESET)"

logs-pricing:
	@tail -f /tmp/bt-logs/pricing.log 2>/dev/null || echo "$(RED)bt-pricing-service not running$(RESET)"

logs-payment:
	@tail -f /tmp/bt-logs/payment.log 2>/dev/null || echo "$(RED)bt-payment-service not running$(RESET)"

logs-cargo:
	@tail -f /tmp/bt-logs/cargo.log 2>/dev/null || echo "$(RED)bt-cargo-ledger not running$(RESET)"

logs-admin:
	@tail -f /tmp/bt-logs/admin.log 2>/dev/null || echo "$(RED)bt-ops-web not running$(RESET)"

# ─── Quick Tests ──────────────────────────────────────────────────────────────
test-auth:
	@echo "$(CYAN)Testing bt-auth-service OTP flow...$(RESET)"
	@echo "\n→ send-otp (invalid phone):"
	@curl -s -X POST http://localhost:3001/auth/send-otp \
		-H 'Content-Type: application/json' \
		-d '{"phone":"123"}' | python3 -m json.tool
	@echo "\n→ send-otp (valid phone, dev mode):"
	@curl -s -X POST http://localhost:3001/auth/send-otp \
		-H 'Content-Type: application/json' \
		-d '{"phone":"9876543210"}' | python3 -m json.tool

test-pricing:
	@echo "$(CYAN)Testing bt-pricing-service...$(RESET)"
	@echo "\n→ Quote: HCV, 150km, heavy machinery, 8000kg:"
	@curl -s -X POST http://localhost:3003/quote \
		-H 'Content-Type: application/json' \
		-d '{"distance_km":150,"vehicle_type":"hcv","load_type":"heavy_machinery","weight_kg":8000}' \
		| python3 -m json.tool
	@echo "\n→ Quote: Mini truck, 30km, general, 500kg:"
	@curl -s -X POST http://localhost:3003/quote \
		-H 'Content-Type: application/json' \
		-d '{"distance_km":30,"vehicle_type":"mini_truck","load_type":"general","weight_kg":500}' \
		| python3 -m json.tool

test-cargo:
	@echo "$(CYAN)Testing bt-cargo-ledger checkpoint + Merkle hash...$(RESET)"
	@echo "\n→ Record a pickup checkpoint:"
	@curl -s -X POST http://localhost:3005/shipments/checkpoint \
		-H 'Content-Type: application/json' \
		-d '{ \
			"shipment_id":"00000000-0000-0000-0000-000000000001", \
			"leg_id":"00000000-0000-0000-0000-000000000002", \
			"checkpoint_type":"pickup", \
			"lat":19.0760, "lng":72.8777, \
			"address":"Dharavi, Mumbai", \
			"pieces_count":10, "weight_kg":500 \
		}' | python3 -m json.tool

# ─── Git ──────────────────────────────────────────────────────────────────────
git-status:
	@echo "$(BOLD)Git Status — All Repos$(RESET)"
	@echo "──────────────────────────────────────────────"
	@for repo in LogisticOS bt-auth-service bt-booking-service bt-pricing-service bt-payment-service bt-cargo-ledger bt-driver-app bt-shipper-app bt-ops-web; do \
		echo "$(CYAN)$$repo$(RESET):"; \
		cd $(BASE)$$repo && git status --short 2>/dev/null || echo "  (no git)"; \
		echo ""; \
	done

git-log:
	@echo "$(BOLD)Recent Commits — All Repos$(RESET)"
	@echo "──────────────────────────────────────────────"
	@for repo in LogisticOS bt-auth-service bt-booking-service bt-pricing-service bt-payment-service bt-cargo-ledger bt-driver-app bt-shipper-app bt-ops-web; do \
		echo "$(CYAN)$$repo$(RESET):"; \
		cd $(BASE)$$repo && git log --oneline -3 2>/dev/null || echo "  (no commits)"; \
		echo ""; \
	done

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "$(YELLOW)Removing node_modules from all services...$(RESET)"
	@for svc in $(ALL_SVCS); do \
		rm -rf $(BASE)$$svc/node_modules && echo "  ✓ $$svc"; \
	done
	@echo "$(GREEN)Done. Run 'make install-all' to reinstall.$(RESET)"
