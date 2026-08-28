# Config is one readyrun.config.ts; init only stubs it

ReadyRun reads a single readyrun.config.ts at the Consumer root (JS/MJS as the same basename). Init writes that stub with defineConfig; Doctor and Run load it. A generated ralph/-style scripts folder was rejected — that is the packaging this product exists to replace. package.json-only config was rejected because it cannot express github() / cursor() factories. Cosmiconfig-style search through many filenames was rejected: unknown keys already fail, and Doctor must know which file it is talking about.
