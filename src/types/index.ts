export type EventHandler<T = any> = (data: T) => void;

export interface WSMessage {
  event: string;
  data?: any;
}
