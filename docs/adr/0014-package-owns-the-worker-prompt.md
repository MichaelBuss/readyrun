# The Worker prompt is the package’s, not a repo prompt.md

Loop instructions and Tracker-specific copy live in the package and are filled by the Tracker Adapter (Ticket id, title, body, URL). A Consumer may append an optional repo context file for local facts (how to test, never push main). That file cannot replace the loop or tracker instructions — that was Ralph’s prompt.md, which is what we are not copying. Package-only (no context file) was rejected because repo facts would then have to live in every Ticket body.
