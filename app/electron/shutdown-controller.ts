export interface UnsavedChangesState {
  hasUnsavedChanges: boolean;
  message: string;
  cancelLabel: string;
  exitLabel: string;
}

export class ShutdownController {
  #state: UnsavedChangesState | null = null;
  #requestPending = false;
  #exiting = false;

  constructor(
    private readonly confirmDiscard: (state: UnsavedChangesState) => Promise<boolean>,
    private readonly exit: () => void,
  ) {}

  update(state: UnsavedChangesState): void {
    this.#state = state;
  }

  async request(): Promise<void> {
    if (this.#requestPending || this.#exiting) {
      return;
    }
    this.#requestPending = true;
    try {
      if (this.#state?.hasUnsavedChanges && !await this.confirmDiscard(this.#state)) {
        return;
      }
      this.#exiting = true;
      this.exit();
    } finally {
      this.#requestPending = false;
    }
  }
}
