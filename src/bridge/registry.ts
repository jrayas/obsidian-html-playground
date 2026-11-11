/** Builds the table of implemented operations. Operations in permissions.ts but not here answer UNSUPPORTED. */
import type { ThemeSnapshot } from "../theme/variables";
import type { Handler } from "./host";
import { filesReadOps } from "./ops/files";
import { formatsOps, type YamlDeps } from "./ops/formats";
import { miscReadOps } from "./ops/misc";
import { destructiveOps } from "./ops/destructive";
import { eventsOps, linksOps, pickOps } from "./ops/links";
import { writeOps } from "./ops/writes";

export interface BridgeDeps {
  yaml: YamlDeps;
  getTheme: () => ThemeSnapshot;
}

export function buildHandlers(deps: BridgeDeps): Map<string, Handler> {
  return new Map<string, Handler>(
    Object.entries({
      ...filesReadOps,
      ...formatsOps(deps.yaml),
      ...miscReadOps(deps.getTheme),
      ...writeOps(),
      ...destructiveOps(),
      ...linksOps(),
      ...eventsOps(),
      ...pickOps(),
    }),
  );
}
