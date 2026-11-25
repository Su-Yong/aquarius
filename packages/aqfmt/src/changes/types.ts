export interface FileBaseline {
  hash: string;
  mode: number;
}

export interface FileState {
  content: Uint8Array;
  mode: number;
}

export interface PlannedFile {
  path: string;
  before: FileState | null;
  after: FileState | null;
}

export interface FileChangePlan {
  projectRoot: string;
  files: PlannedFile[];
}

export type PlanSide = "before" | "after";

export interface UndoStore {
  begin(plan: FileChangePlan, createdDirectories: readonly string[]): Promise<UndoTransaction>;
}

export interface UndoTransaction {
  readonly committed: boolean;
  commit(createdDirectories: readonly string[]): Promise<void>;
  abort(): Promise<void>;
  preserve(): Promise<void>;
}
