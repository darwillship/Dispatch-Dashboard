DISPATCH DASHBOARD v1.4.0

Changes:
- Removed Route Title from Create Route.
- Route title is generated automatically from Pickup → Delivery.
- Added Edit Route.
- Added Delete Route with confirmation.
- Added quick status dropdown: Pending, Assigned, In Progress, Completed.
- Added drag-and-drop task reordering.
- Custom task order is remembered in that browser.
- Driver names now display instead of only Driver ID.
- Existing saved locations and vehicle dropdown remain.

IMPORTANT:
The custom order is currently stored in the browser so this update requires NO Supabase schema change.
A later update can sync the same order across every shipping-team computer by adding a sort_order column to Supabase.

Vehicle selection is still visible but intentionally not saved until a dedicated vehicle field is added to dispatch_tasks.
