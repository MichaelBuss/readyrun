# Model is default, then CLI, then label map — never on the Ticket

A Worker’s model id comes from a required config default (Doctor fails if missing). `--model` overrides that default for the whole Run. A by-label map may override per Ticket using labels the Tracker Adapter already has. The Ticket body does not name a model — that would be special authoring. CLI-always-wins was rejected so a review label can still pin a cheaper model; default-only was rejected because a Run override is the first afternoon’s need. The Worker Adapter passes the string through.
