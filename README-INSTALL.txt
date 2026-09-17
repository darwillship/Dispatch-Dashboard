DISPATCH DASHBOARD v1.3.1 CLEAN

This version was rebuilt from the last working dashboard instead of patching the broken vehicle build.

Fix:
- Removed the malformed regular-expression code that caused:
  "Uncaught SyntaxError: Invalid regular expression ... Unmatched ')'"

Includes:
- Complete Driver Timesheet company/address list
- MSI
- Palatine Post Office (1300 E Northwest Hwy)
- Vehicle dropdown
- Existing working Supabase route creation

IMPORTANT:
Vehicle can be selected in the form, but it is intentionally NOT written to Supabase yet.
We will connect vehicle saving after confirming/adding the correct dispatch_tasks vehicle column.
