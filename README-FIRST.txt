SHIFT Dispatch v2.5 — Saved Customer Locations

STEP 1
Run SUPABASE-SAVED-LOCATIONS.sql once in Supabase SQL Editor.

STEP 2
Replace index.html in the Dispatch-Dashboard GitHub repository.
The existing shift-logo.png can stay as-is.

New workflow:
1. Pickup or Delivery → + Type a new location…
2. Enter customer/location name and full address.
3. Check “Save this location for future routes.”
4. Save the task.
5. The location becomes available under “Saved Customers” in both Pickup and Delivery dropdowns for the whole team.

The route itself still stores the customer name/address, so existing Driver app behavior is preserved.

All v2.4.2 features remain, including mobile drag-and-drop and the single status-color stripe.
