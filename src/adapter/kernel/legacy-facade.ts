/**
 * P1 incremental bridge from the legacy adapter services to the new
 * HostFacade.
 *
 * This bridge exposes only the read-only Host Descriptor snapshot; it is not
 * a full kernel runtime. It does NOT
 * expose admission, grants, or ledger writes: those are sensitive Kernel /
 * Standard internal services and must not be callable through the Host Port /
 * HostFacade surface (especially in passive shadow).
 *
 * `facadeFromLegacy` is a retained long-term compatibility fallback for
 * bare/test compositions and is explicitly outside the P6 removal scope.
 * OWNER: dsh-tui adapter. UNTIL: no scheduled removal.
 */

import type { HostDescriptorSnapshot, HostDescriptorPort } from '../ports/descriptor.js'
import type { HostDescriptorBuild } from '../standard/descriptor.js'
import { createHostFacade, type HostFacade } from './host-facade.js'

export interface LegacyHostServices {
  readonly generationId: string
  describe(): HostDescriptorBuild
}

export function facadeFromLegacy(services: LegacyHostServices): HostFacade {
  const descriptor: HostDescriptorPort = Object.freeze({
    get generationId() {
      return services.generationId
    },
    snapshot(): HostDescriptorSnapshot {
      const build = services.describe()
      return Object.freeze({
        hostId: build.descriptor.hostId,
        hostVersion: build.descriptor.hostVersion,
        generationId: build.descriptor.runtime.generationId,
        contracts: Object.freeze(build.descriptor.contracts.map(contract => `${contract.apiVersion}#${contract.kind}`)),
        dropped: Object.freeze([...build.dropped]),
        warnings: Object.freeze([...build.warnings]),
      })
    },
  })

  return createHostFacade({ descriptor })
}
