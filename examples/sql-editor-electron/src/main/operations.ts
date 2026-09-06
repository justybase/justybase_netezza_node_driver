export type OperationKind = 'query' | 'import-preview' | 'import' | 'export-csv' | 'export-excel';

export type OperationPhase = 'query' | 'preview' | 'stream' | 'load' | 'export';

export interface OperationProgress {
  operationId: string;
  kind: OperationKind;
  phase: OperationPhase;
  message: string;
  percent?: number;
  rows?: number;
}

export class OperationCanceledError extends Error {
  constructor(message = 'Operation canceled.') {
    super(message);
    this.name = 'OperationCanceledError';
  }
}

export class OperationBusyError extends Error {
  constructor() {
    super('Another database operation is already running. Wait for it to finish or cancel it first.');
    this.name = 'OperationBusyError';
  }
}

export class OperationContext {
  public readonly id: string;
  public readonly kind: OperationKind;
  private readonly progressHandler?: (progress: OperationProgress) => void;
  private canceledState = false;
  private cancelHandler: (() => Promise<void> | void) | undefined;
  private readonly cancelHandlers = new Set<() => Promise<void> | void>();
  private readonly cancelTasks: Promise<void>[] = [];

  constructor(id: string, kind: OperationKind, progressHandler?: (progress: OperationProgress) => void) {
    this.id = id;
    this.kind = kind;
    this.progressHandler = progressHandler;
  }

  get canceled(): boolean {
    return this.canceledState;
  }

  setCancelHandler(handler: () => Promise<void> | void): void {
    this.cancelHandler = handler;
    if (this.canceledState) this.startCancel(handler);
  }

  async cancel(): Promise<void> {
    this.canceledState = true;
    if (this.cancelHandler) this.startCancel(this.cancelHandler);
    while (this.cancelTasks.length > 0) {
      const tasks = this.cancelTasks.splice(0);
      await Promise.all(tasks);
    }
  }

  private startCancel(handler: () => Promise<void> | void): void {
    if (this.cancelHandlers.has(handler)) return;
    this.cancelHandlers.add(handler);
    this.cancelTasks.push(Promise.resolve().then(() => handler()).catch(() => undefined));
  }

  checkCanceled(): void {
    if (this.canceledState) throw new OperationCanceledError();
  }

  progress(progress: Omit<OperationProgress, 'operationId' | 'kind'>): void {
    this.progressHandler?.({ operationId: this.id, kind: this.kind, ...progress });
  }
}

let activeOperation: OperationContext | null = null;

export function beginOperation(
  id: string,
  kind: OperationKind,
  progressHandler?: (progress: OperationProgress) => void
): OperationContext {
  if (activeOperation) throw new OperationBusyError();
  const operation = new OperationContext(id || `operation-${Date.now()}`, kind, progressHandler);
  activeOperation = operation;
  return operation;
}

export async function cancelOperation(id?: string): Promise<boolean> {
  if (!activeOperation || (id && activeOperation.id !== id)) return false;
  await activeOperation.cancel();
  return true;
}

export function finishOperation(id: string): void {
  if (activeOperation?.id === id) activeOperation = null;
}

export function currentOperation(): { id: string; kind: OperationKind; canceled: boolean } | null {
  if (!activeOperation) return null;
  return { id: activeOperation.id, kind: activeOperation.kind, canceled: activeOperation.canceled };
}
