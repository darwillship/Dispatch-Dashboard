#!/bin/bash
# Local test of SUPABASE-AUTO-TRIPS.sql on a throwaway Postgres (never the live project).
# Usage: PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres ./run.sh   (needs a scratch server; creates/drops database "t")
set -o pipefail
: "${PGHOST:=/tmp/pgt}" "${PGPORT:=55432}" "${PGUSER:=postgres}"
P="psql -h $PGHOST -p $PGPORT -U $PGUSER -v ON_ERROR_STOP=1 -q"
cd "$(dirname "$0")"; MIG="$(cd ../../.. && pwd)/SUPABASE-AUTO-TRIPS.sql"
$P -c "drop database if exists t" -c "create database t" 2>/dev/null && $P -d t -f base.sql && $P -d t -f live_funcs.sql && $P -d t -q >/dev/null <<'EOF' && $P -d t -f live_view.sql && $P -d t -f "$MIG" 2>/dev/null && $P -d t -f "$MIG" 2>/dev/null && psql -h $PGHOST -p $PGPORT -U $PGUSER -d t -q -f scenarios.sql 2>&1 | grep -E "PASS|FAIL|ERROR|split"
create trigger dispatch_task_stops_route_complete after insert or update of status on public.dispatch_task_stops for each row execute function dispatch_task_stops_route_complete();
create trigger dispatch_task_stops_source_progress after update of status on public.dispatch_task_stops for each row execute function dispatch_task_stops_source_progress();
create trigger dispatch_tasks_stamp_assigned before insert or update of assigned_driver_id, vehicle_id on public.dispatch_tasks for each row execute function dispatch_tasks_stamp_assigned();
create trigger dispatch_tasks_status_manual before update of status on public.dispatch_tasks for each row execute function dispatch_tasks_status_manual();
create view dispatch_route_stops_v as select s.id as stop_id from dispatch_task_stops s;
EOF
