import type { RealtimeEvent } from "@pm/shared";

type Listener = (event: RealtimeEvent) => void;

export class EventHub {
  private listeners = new Set<Listener>();
  emit(event: RealtimeEvent) { for (const listener of this.listeners) listener(event); }
  subscribe(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
