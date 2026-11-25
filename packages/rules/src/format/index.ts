import { architectureFormatRules } from "./architecture";
import { commentErrorRules } from "./comments-errors";
import { controlFlowRules } from "./control-flow";
import { customRules } from "./custom";
import { expressionRules } from "./expressions";
import { importRules } from "./imports";
import { namingRules } from "./naming";
import { refactorRules } from "./refactor";
import { structureRules } from "./structure";
import { testRules } from "./tests";
import { typeRules } from "./types";

export const formatRules = [
  ...importRules,
  ...controlFlowRules,
  ...expressionRules,
  ...namingRules,
  ...structureRules,
  ...typeRules,
  ...commentErrorRules,
  ...testRules,
  ...refactorRules,
  ...architectureFormatRules,
  ...customRules,
];
