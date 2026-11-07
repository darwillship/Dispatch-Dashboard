-- SHIFT v4.10.1 — complete a route that was itself combined into another route (e.g. #310 inside #312).
-- vzc-sync skips combined routes ("combined into route #312") and dispatch_task_stops_source_progress only completes the
-- ORIGINAL tasks, so an inner route stayed "in progress" after all of its work was done. This trigger completes the
-- inner route as soon as every task combined into it is completed (completed_at = the latest of theirs).
-- Additive, idempotent; NOT applied yet (needs Jonathan's OK together with the v4.10.1 deploy).
create or replace function public.dispatch_tasks_complete_inner_route() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.dispatch_tasks%rowtype; last_done timestamptz;
begin
  begin
    if new.status is distinct from 'completed' or old.status is not distinct from 'completed' or new.combined_into_task_id is null then return null; end if;
    select * into r from public.dispatch_tasks where id = new.combined_into_task_id;
    if not found or not coalesce(r.is_route, false) or r.combined_into_task_id is null or r.status = 'completed' or r.status ~* 'cancel' then return null; end if;
    if exists (select 1 from public.dispatch_tasks o where o.combined_into_task_id = r.id and o.status is distinct from 'completed' and coalesce(o.status,'') !~* 'cancel') then return null; end if;
    select max(o.completed_at) into last_done from public.dispatch_tasks o where o.combined_into_task_id = r.id;
    update public.dispatch_tasks
       set status = 'completed', completed_at = coalesce(completed_at, last_done, now()),
           status_source = case when new.status_source in ('auto_gps','manual') then new.status_source else status_source end,
           status_auto_at = case when new.status_source = 'auto_gps' then clock_timestamp() else status_auto_at end
     where id = r.id and status is distinct from 'completed';
  exception when others then
    raise warning 'dispatch_tasks_complete_inner_route: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists dispatch_tasks_complete_inner_route on public.dispatch_tasks;
create trigger dispatch_tasks_complete_inner_route after update of status on public.dispatch_tasks
  for each row execute function public.dispatch_tasks_complete_inner_route();
