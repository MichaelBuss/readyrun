# Doctor and Run start fail when config lies about the Frontier

Unknown keys, a missing frontier label, config repo ≠ git remote, and claiming unblocked when the Tracker cannot express blocking are hard failures: Doctor fails and a Run will not start. Unused routing (a by-label model with no matching Tickets) is a warning — it is not a lie about what will be picked. Checks run once at Run start, not every iteration. Warn-and-continue was rejected because it burns the cap on a misconfigured Consumer.
