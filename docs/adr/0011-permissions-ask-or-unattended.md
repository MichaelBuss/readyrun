# Permissions are ask | unattended, never a silent vendor flag

Permissions are a first-class Run policy with two string literals: ask (default) and unattended. Looping is not unattended; Ralph’s silent --yolo was rejected. Each Worker Adapter maps unattended to its own flag; custom must be told the flag. A boolean yolo and a third sandbox-off value were rejected: yolo is Cursor slang, and sandbox-bypass is a second axis with no current use on cursor/claude.
