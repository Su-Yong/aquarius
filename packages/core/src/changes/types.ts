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
