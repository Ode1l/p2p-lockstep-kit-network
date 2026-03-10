// Simple event bus:
// - on(event, handler): subscribe
// - off(event, handler): unsubscribe
// - emit(event, payload): notify all handlers
export class Emitter<Events extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof Events, Set<(payload: any) => void>>();

  // Subscribe a handler for an event.
  public on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: any) => void);
    this.handlers.set(event, set);
  }

  // Unsubscribe a handler for an event.
  public off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void) {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler as (payload: any) => void);
    }
  }

  // Emit an event to all subscribed handlers.
  public emit<K extends keyof Events>(event: K, payload: Events[K]) {
    const set = this.handlers.get(event);
    if (!set) {
      return;
    }
    for (const handler of set) {
      handler(payload);
    }
  }
}
