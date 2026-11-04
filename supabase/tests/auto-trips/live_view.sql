drop view dispatch_route_stops_v; create view public.dispatch_route_stops_v as  SELECT s.id AS stop_id,
    s.task_id,
    s.seq,
    row_number() OVER w AS stop_number,
    count(*) OVER (PARTITION BY s.task_id) AS stop_count,
    s.stop_type,
    s.location_id,
    s.location_name,
    s.location_address,
    s.material,
    s.pallet_qty,
    s.notes,
    s.status,
        CASE
            WHEN lag(s.id) OVER w IS NULL THEN t.pickup_name
            ELSE lag(s.location_name) OVER w
        END AS prev_location_name,
        CASE
            WHEN lag(s.id) OVER w IS NULL THEN t.gps_departed_at
            ELSE lag(s.gps_departed_at) OVER w
        END AS prev_departed_at,
    s.gps_arrived_at,
    s.gps_departed_at,
    round(EXTRACT(epoch FROM s.gps_arrived_at -
        CASE
            WHEN lag(s.id) OVER w IS NULL THEN t.gps_departed_at
            ELSE lag(s.gps_departed_at) OVER w
        END) / 60::numeric)::integer AS leg_drive_minutes,
    s.gps_dwell_minutes,
    s.gps_vehicle_id,
    sv.name AS gps_vehicle_name,
    s.gps_source,
    s.gps_updated_at,
    t.work_date,
    t.title AS task_title,
    t.task_type,
    t.status AS task_status,
    t.is_route,
    t.combined_into_task_id,
    t.scheduled_at,
    t.planning_stage,
    t.sort_order,
    t.completed_at AS task_completed_at,
    t.pickup_name AS origin_name,
    t.pickup_address AS origin_address,
    t.gps_departed_at AS origin_departed_at,
    t.assigned_driver_id AS driver_id,
    d.name AS driver_name,
    COALESCE(ds.vehicle_id, d.default_vehicle_id) AS vehicle_id,
    v.name AS vehicle_name,
    s.gps_engine_off_at,
    s.gps_engine_on_at,
    s.gps_idle_minutes,
    s.gps_engine_off_minutes,
    s.gps_match_method,
    s.gps_match_distance_m,
    t.gps_returned_base_at AS task_returned_base_at
   FROM dispatch_task_stops s
     JOIN dispatch_tasks t ON t.id = s.task_id
     LEFT JOIN drivers d ON d.id = t.assigned_driver_id
     LEFT JOIN driver_schedule ds ON ds.driver_id = t.assigned_driver_id AND ds.work_date = t.work_date
     LEFT JOIN vehicles v ON v.id = COALESCE(ds.vehicle_id, d.default_vehicle_id)
     LEFT JOIN vehicles sv ON sv.id = s.gps_vehicle_id
  WINDOW w AS (PARTITION BY s.task_id ORDER BY s.seq, s.id);