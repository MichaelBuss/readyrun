# A Frontier is unblocked plus a selector plus an optional root

v0 names a Frontier as a Tracker Adapter query: ready is the string literal "unblocked" (not a boolean), plus a Consumer selector (GitHub labels or Linear’s equivalent), plus an optional root (a parent id or an explicit list of Ticket ids). Parent-only was rejected because SpeechDeck’s work is a label frontier after the map issue closed. Labels without unblocked was rejected because a blocked Ticket would still be picked. Ticket bodies do not name the Frontier.
