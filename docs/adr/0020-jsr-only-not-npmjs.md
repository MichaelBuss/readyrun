# JSR only; not npmjs.com

**Overturned by [ADR 0045](0045-a-release-pr-is-the-only-publish-lever-and-every-version-ships-to-npm-and-jsr.md):** every version now publishes to npm (trusted publishing) as well as JSR; the bin-stripping objection below died with direct npm. Kept for the record.

ReadyRun is published to jsr.io as `@readyrun/readyrun`. It is not published to registry.npmjs.org. A Consumer still installs with npm, pnpm, or yarn through JSR’s npm compatibility layer (`pnpm add jsr:@readyrun/readyrun` or `npx jsr add @readyrun/readyrun`). Dual-publish was rejected for v0: two registries, two auth stories, and the package is already “published (JSR).” The cost is that JSR’s npm-compat tarball strips `bin`, so a JSR install does not put `readyrun` on PATH. The CLI is the `cli` export, run as a program.
