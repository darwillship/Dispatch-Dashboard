SHIFT Dispatch v2.5.3 — Location Reliability

Replace only index.html in GitHub.
No new Supabase SQL is required for this update.

Changes:
- Selecting Pickup or Delivery now shows the customer/location name AND full address directly below the dropdown.
- Custom location previews update while typing.
- A failure to add a customer to Saved Customers no longer blocks the dispatch route.
- The route saves normally even if the saved-location database request fails.
- If Saved Customers fails, SHIFT now displays the actual Supabase error so the database issue can be diagnosed precisely.
- Existing mobile drag, status controls, daily completed routes, History, and custom locations remain.

If an error appears after saving a route, take a photo of the exact “Supabase error” text. The route itself will already be saved.
