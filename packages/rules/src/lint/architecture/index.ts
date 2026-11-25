import { documentBoundaryExceptions } from "./document-boundary-exceptions";
import { enforceLayerDirection } from "./enforce-layer-direction";
import { explicitCommunicationStyle } from "./explicit-communication-style";
import { explicitPluginExtensionPoints } from "./explicit-plugin-extension-points";
import { explicitTrustBoundaries } from "./explicit-trust-boundaries";
import { frameworkIndependentDomain } from "./framework-independent-domain";
import { isolateExternalModels } from "./isolate-external-models";
import { isolateLegacyBoundaries } from "./isolate-legacy-boundaries";
import { isolatePlatformSpecificCode } from "./isolate-platform-specific-code";
import { noCrossDomainInternals } from "./no-cross-domain-internals";
import { noDependencyCycles } from "./no-dependency-cycles";
import { noSharedDatabaseBypass } from "./no-shared-database-bypass";
import { noUseCaseBypass } from "./no-use-case-bypass";
import { persistenceIndependentDomain } from "./persistence-independent-domain";
import { transportIndependentUseCases } from "./transport-independent-use-cases";

export const architectureRules = [
  enforceLayerDirection,
  noDependencyCycles,
  frameworkIndependentDomain,
  transportIndependentUseCases,
  persistenceIndependentDomain,
  noCrossDomainInternals,
  noSharedDatabaseBypass,
  explicitCommunicationStyle,
  explicitTrustBoundaries,
  isolateExternalModels,
  isolateLegacyBoundaries,
  isolatePlatformSpecificCode,
  explicitPluginExtensionPoints,
  noUseCaseBypass,
  documentBoundaryExceptions,
];
