---
"@readyrun/readyrun": patch
---

A Tracker failure at the last step of a Ticket — `leaveFrontier` throwing after the Ticket's merge succeeded — now hard-stops with a report that names the Landing: the Ticket, the Run Branch it landed on, and the merge commit it landed as, plus the manual step of taking the Ticket off the Frontier by hand before continuing. That stop is the one place where the Frontier keeps finished work (#114, ADR 0049); the report is the compensation, and Tracker failures before any Landing exists report exactly as before.
