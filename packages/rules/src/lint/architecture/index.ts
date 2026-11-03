import { enforceLayerDirection } from "./enforce-layer-direction";
import { noDependencyCycles } from "./no-dependency-cycles";
import { frameworkIndependentDomain } from "./framework-independent-domain";
import { transportIndependentUseCases } from "./transport-independent-use-cases";
import { persistenceIndependentDomain } from "./persistence-independent-domain";
import { noCrossDomainInternals } from "./no-cross-domain-internals";
import { noSharedDatabaseBypass } from "./no-shared-database-bypass";
import { explicitCommunicationStyle } from "./explicit-communication-style";
import { explicitTrustBoundaries } from "./explicit-trust-boundaries";
import { isolateExternalModels } from "./isolate-external-models";
import { isolateLegacyBoundaries } from "./isolate-legacy-boundaries";
import { isolatePlatformSpecificCode } from "./isolate-platform-specific-code";
import { explicitPluginExtensionPoints } from "./explicit-plugin-extension-points";
import { noUseCaseBypass } from "./no-use-case-bypass";
import { documentBoundaryExceptions } from "./document-boundary-exceptions";

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
