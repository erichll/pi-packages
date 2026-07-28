type ScopeState = {
  consecutiveDenials: number;
  rolling: boolean[];
};

export type CircuitBreakerResult = {
  tripped: boolean;
  consecutiveDenials: number;
  rollingDenials: number;
};

export class DenialCircuitBreaker {
  readonly #scopes = new Map<string, ScopeState>();
  private readonly consecutiveLimit: number;
  private readonly rollingDenialLimit: number;
  private readonly rollingWindow: number;

  constructor(
    consecutiveLimit = 3,
    rollingDenialLimit = 10,
    rollingWindow = 50,
  ) {
    this.consecutiveLimit = consecutiveLimit;
    this.rollingDenialLimit = rollingDenialLimit;
    this.rollingWindow = rollingWindow;
  }

  record(scopeKey: string, denied: boolean): CircuitBreakerResult {
    const state = this.#scopes.get(scopeKey) ?? {
      consecutiveDenials: 0,
      rolling: [],
    };
    state.consecutiveDenials = denied
      ? state.consecutiveDenials + 1
      : 0;
    state.rolling.push(denied);
    if (state.rolling.length > this.rollingWindow) state.rolling.shift();
    this.#scopes.set(scopeKey, state);
    const rollingDenials = state.rolling.filter(Boolean).length;
    return {
      tripped:
        state.consecutiveDenials >= this.consecutiveLimit ||
        rollingDenials >= this.rollingDenialLimit,
      consecutiveDenials: state.consecutiveDenials,
      rollingDenials,
    };
  }

  isTripped(scopeKey: string): boolean {
    const state = this.#scopes.get(scopeKey);
    if (!state) return false;
    return (
      state.consecutiveDenials >= this.consecutiveLimit ||
      state.rolling.filter(Boolean).length >= this.rollingDenialLimit
    );
  }

  clear(): void {
    this.#scopes.clear();
  }
}
