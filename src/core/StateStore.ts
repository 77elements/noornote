type StateCallback<T> = (state: T) => void;

export class StateStore<T extends object> {
  private state: T;
  private subscribers = new Set<StateCallback<T>>();

  constructor(initial: T) {
    this.state = { ...initial };
  }

  get(): T {
    return { ...this.state };
  }

  set(updates: Partial<T>): void {
    this.state = { ...this.state, ...updates } as T;
    this.notify();
  }

  subscribe(callback: StateCallback<T>): () => void {
    this.subscribers.add(callback);
    callback(this.get());
    return () => this.subscribers.delete(callback);
  }

  reset(initial: T): void {
    this.state = { ...initial };
    this.notify();
  }

  private notify(): void {
    const current = this.get();
    this.subscribers.forEach(cb => cb(current));
  }
}
